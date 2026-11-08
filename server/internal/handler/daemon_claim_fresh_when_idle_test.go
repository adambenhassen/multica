package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// An agent with fresh_session_when_idle starts a follow-up in a new session
// once its last session on the issue has sat unused past the prompt-cache
// lifetime, and keeps resuming while the cache is still warm.
func TestClaimTask_FreshSessionWhenIdle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	cases := []struct {
		name        string
		optedIn     bool
		idle        string
		wantSession bool
	}{
		{name: "opted out resumes an idle session", optedIn: false, idle: "2 hours", wantSession: true},
		{name: "opted in starts fresh after the cutoff", optedIn: true, idle: "2 hours", wantSession: false},
		{name: "opted in resumes a warm session", optedIn: true, idle: "10 minutes", wantSession: true},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, ctx)
			dbfx.Exec(t, `UPDATE agent SET fresh_session_when_idle = $2 WHERE id = $1`, agentID, tc.optedIn)

			issueID := dbfx.Issue(t, "fresh when idle fixture", testutil.Cols{
				"status": "in_progress",
				"number": 87100 + i,
			})
			dbfx.Exec(t, `
				INSERT INTO agent_task_queue (
					agent_id, runtime_id, issue_id,
					status, priority, started_at, completed_at, session_id, work_dir
				)
				VALUES ($1, $2, $3, 'completed', 0, now() - $4::interval - interval '5 minutes',
				        now() - $4::interval, 'idle-session', '/tmp/idle-workdir')
			`, agentID, runtimeID, issueID, tc.idle)
			dbfx.Exec(t, `
				INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
				VALUES ($1, $2, $3, 'queued', 0)
			`, agentID, runtimeID, issueID)

			task := claimTaskForRuntimeGuard(t, runtimeID, daemonID)
			if got := task.PriorSessionID != ""; got != tc.wantSession {
				t.Fatalf("PriorSessionID = %q, want resumed=%v", task.PriorSessionID, tc.wantSession)
			}
			if task.PriorWorkDir != "/tmp/idle-workdir" {
				t.Fatalf("PriorWorkDir = %q, want /tmp/idle-workdir (the workdir is reused either way)", task.PriorWorkDir)
			}
			if task.PriorSessionResumeUnavailable {
				t.Fatal("PriorSessionResumeUnavailable = true, want false (a deliberate fresh start is not a lost session)")
			}
		})
	}
}

func TestUpdateAgent_FreshSessionWhenIdle(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "fresh-when-idle-update", nil)
	update := func(body map[string]any) AgentResponse {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.UpdateAgent(w, withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, body), "id", agentID))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
		}
		var resp AgentResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return resp
	}
	persisted := func() bool {
		t.Helper()
		var got bool
		if err := testPool.QueryRow(context.Background(),
			`SELECT fresh_session_when_idle FROM agent WHERE id = $1`, agentID,
		).Scan(&got); err != nil {
			t.Fatalf("read fresh_session_when_idle: %v", err)
		}
		return got
	}

	if resp := update(map[string]any{"fresh_session_when_idle": true}); !resp.FreshSessionWhenIdle || !persisted() {
		t.Fatalf("enable: response=%v persisted=%v, want true", resp.FreshSessionWhenIdle, persisted())
	}
	if resp := update(map[string]any{"description": "flag unchanged"}); !resp.FreshSessionWhenIdle || !persisted() {
		t.Fatalf("omitted: response=%v persisted=%v, want the saved true preserved", resp.FreshSessionWhenIdle, persisted())
	}
	if resp := update(map[string]any{"fresh_session_when_idle": false}); resp.FreshSessionWhenIdle || persisted() {
		t.Fatalf("disable: response=%v persisted=%v, want false", resp.FreshSessionWhenIdle, persisted())
	}
}

func TestIdleSessionStartsFresh(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	at := func(idle time.Duration) pgtype.Timestamptz {
		return pgtype.Timestamptz{Time: now.Add(-idle), Valid: true}
	}
	optedIn := db.Agent{FreshSessionWhenIdle: true}
	cases := []struct {
		name     string
		agent    db.Agent
		lastUsed pgtype.Timestamptz
		want     bool
	}{
		{"just under the cutoff resumes", optedIn, at(49 * time.Minute), false},
		{"exactly at the cutoff resumes", optedIn, at(idleFreshSessionCutoff), false},
		{"just past the cutoff starts fresh", optedIn, at(51 * time.Minute), true},
		{"unknown last use resumes", optedIn, pgtype.Timestamptz{}, false},
		{"opted out always resumes", db.Agent{}, at(5 * time.Hour), false},
	}
	for _, tc := range cases {
		if got := idleSessionStartsFresh(tc.agent, tc.lastUsed, now); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
