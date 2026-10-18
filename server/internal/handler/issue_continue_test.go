package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/dispatch"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

// A rerun with "continue" and no task_id runs the assignee without forcing a
// fresh session; without the flag the rerun keeps its fresh-session default.
func TestRerunIssue_ContinueKeepsSession(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID := createHandlerTestAgent(t, "ContinueIssueAgent", []byte("[]"))
	issueID := dbfx.Issue(t, "continue run", testutil.Cols{"assignee_type": "agent", "assignee_id": agentID})
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
	})

	for _, tc := range []struct {
		name      string
		body      map[string]any
		wantFresh bool
	}{
		{name: "continue", body: map[string]any{"continue": true}, wantFresh: false},
		{name: "plain rerun", body: map[string]any{}, wantFresh: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := withURLParam(newRequest("POST", "/api/issues/"+issueID+"/rerun", tc.body), "id", issueID)
			testHandler.RerunIssue(w, req)
			if w.Code != http.StatusAccepted {
				t.Fatalf("RerunIssue: expected 202, got %d: %s", w.Code, w.Body.String())
			}
			var resp struct {
				ID      string `json:"id"`
				AgentID string `json:"agent_id"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.AgentID != agentID {
				t.Fatalf("agent_id = %q, want assignee %q", resp.AgentID, agentID)
			}
			var fresh bool
			if err := testPool.QueryRow(ctx,
				`SELECT COALESCE(force_fresh_session, false) FROM agent_task_queue WHERE id = $1`, resp.ID,
			).Scan(&fresh); err != nil {
				t.Fatalf("read force_fresh_session: %v", err)
			}
			if fresh != tc.wantFresh {
				t.Fatalf("force_fresh_session = %v, want %v", fresh, tc.wantFresh)
			}
		})
	}
}

// A waiting run may carry a wakeup instruction, handoff note or autopilot link,
// so "continue" must leave it in place and report it instead of replacing it.
func TestRerunIssue_ContinueKeepsWaitingRun(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID := createHandlerTestAgent(t, "ContinueWaitingAgent", []byte("[]"))
	issueID := dbfx.Issue(t, "continue waiting run", testutil.Cols{"assignee_type": "agent", "assignee_id": agentID})
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
	})

	issue, err := testHandler.Queries.GetIssue(ctx, util.MustParseUUID(issueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}
	waiting, err := testHandler.TaskService.EnqueueTaskForIssue(ctx, issue)
	if err != nil {
		t.Fatalf("enqueue waiting task: %v", err)
	}

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/issues/"+issueID+"/rerun", map[string]any{"continue": true}), "id", issueID)
	testHandler.RerunIssue(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("RerunIssue continue with a waiting run: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	if code := readReasonCode(t, w.Body.Bytes()); code != string(dispatch.ReasonAlreadyActive) {
		t.Errorf("reason_code = %q, want already_active", code)
	}

	var status string
	var count int
	if err := testPool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id = $1`, waiting.ID).Scan(&status); err != nil {
		t.Fatalf("read waiting task: %v", err)
	}
	if status != "queued" {
		t.Errorf("waiting task status = %q, want queued", status)
	}
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE issue_id = $1`, issueID).Scan(&count); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	if count != 1 {
		t.Errorf("task count = %d, want 1 (nothing enqueued)", count)
	}
}
