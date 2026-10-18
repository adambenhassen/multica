package handler

import (
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestAgentRunCountsLastRunAt(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "run counts runtime")
	agentID := dbfx.Agent(t, "run counts agent", runtimeID)

	type row struct {
		AgentID       string  `json:"agent_id"`
		RunCount      int     `json:"run_count"`
		LastHourCount int     `json:"last_hour_count"`
		LastRunAt     *string `json:"last_run_at"`
	}
	read := func(t *testing.T) row {
		t.Helper()
		var rows []row
		req := withChatTestWorkspaceCtx(t, newRequest(http.MethodGet, "/api/agent-run-counts", nil))
		testutil.Call(t, testHandler.GetWorkspaceAgentRunCounts, req).Want(http.StatusOK).JSON(&rows)
		for _, r := range rows {
			if r.AgentID == agentID {
				return r
			}
		}
		t.Fatalf("agent %s missing from run counts: %+v", agentID, rows)
		return row{}
	}
	wantAbout := func(t *testing.T, got *string, ago time.Duration) {
		t.Helper()
		if got == nil {
			t.Fatalf("last_run_at = null, want about %s ago", ago)
		}
		at, err := time.Parse(time.RFC3339, *got)
		if err != nil {
			t.Fatalf("parse last_run_at %q: %v", *got, err)
		}
		if d := time.Since(at) - ago; d < -time.Minute || d > time.Minute {
			t.Fatalf("last_run_at = %s (%s ago), want about %s ago", *got, time.Since(at).Round(time.Second), ago)
		}
	}

	// A queued run that never started counts as a run but not as activity.
	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "queued"})
	t.Run("never_started", func(t *testing.T) {
		got := read(t)
		if got.RunCount != 1 || got.LastRunAt != nil {
			t.Fatalf("run_count/last_run_at = %d/%v, want 1/null", got.RunCount, got.LastRunAt)
		}
	})

	dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":   runtimeID,
		"status":       "completed",
		"started_at":   testutil.Raw("now() - interval '3 hours'"),
		"completed_at": testutil.Raw("now() - interval '2 hours'"),
	})
	t.Run("completed_run", func(t *testing.T) { wantAbout(t, read(t).LastRunAt, 2*time.Hour) })

	// A running task counts from its start.
	dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID,
		"status":     "running",
		"started_at": testutil.Raw("now() - interval '10 minutes'"),
	})
	t.Run("running_run", func(t *testing.T) { wantAbout(t, read(t).LastRunAt, 10*time.Minute) })

	// Runs created over an hour ago count toward the 30-day total only.
	dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID,
		"status":     "queued",
		"created_at": testutil.Raw("now() - interval '2 hours'"),
	})
	t.Run("last_hour_count", func(t *testing.T) {
		got := read(t)
		if got.RunCount != 4 || got.LastHourCount != 3 {
			t.Fatalf("run_count/last_hour_count = %d/%d, want 4/3", got.RunCount, got.LastHourCount)
		}
	})
}
