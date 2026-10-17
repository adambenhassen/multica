package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestClaimFallbackRunSendsEntryModel claims a fallback run on its fallback
// runtime and checks the payload carries the run's model and effort, and drops
// the agent's provider-specific custom_args and service_tier.
func TestClaimFallbackRunSendsEntryModel(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	primaryRuntimeID := createClaimReclaimRuntime(t, ctx, "Fallback claim primary")
	fallbackRuntimeID := createClaimReclaimRuntime(t, ctx, "Fallback claim secondary")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, primaryRuntimeID, "Fallback claim agent")
	dbfx.Exec(t, `UPDATE agent SET model = 'claude-opus-5-5', thinking_level = 'max', service_tier = 'priority', custom_args = '["--verbose"]'::jsonb WHERE id = $1`, agentID)
	dbfx.Insert(t, "agent_model_fallback", testutil.Cols{
		"workspace_id": testWorkspaceID, "agent_id": agentID, "position": 1,
		"runtime_id": fallbackRuntimeID, "model": "gpt-5.6-terra", "thinking_level": "xhigh",
	})
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": fallbackRuntimeID, "issue_id": issueID, "status": "queued",
		"model": "gpt-5.6-terra", "fallback_position": 1,
	})

	req := newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+fallbackRuntimeID+"/tasks/claim", nil,
		testWorkspaceID, "fallback-claim")
	req = withURLParam(req, "runtimeId", fallbackRuntimeID)
	w := testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK)

	var resp struct {
		Task *struct {
			ID    string `json:"id"`
			Agent *struct {
				Model         string   `json:"model"`
				ThinkingLevel string   `json:"thinking_level"`
				ServiceTier   string   `json:"service_tier"`
				CustomArgs    []string `json:"custom_args"`
			} `json:"agent"`
		} `json:"task"`
	}
	w.JSON(&resp)
	if resp.Task == nil || resp.Task.ID != taskID || resp.Task.Agent == nil {
		t.Fatalf("claim = %s, want fallback task %s with an agent payload", w.Body.String(), taskID)
	}
	got := resp.Task.Agent
	if got.Model != "gpt-5.6-terra" || got.ThinkingLevel != "xhigh" {
		t.Errorf("model/effort = %q/%q, want gpt-5.6-terra/xhigh", got.Model, got.ThinkingLevel)
	}
	if got.ServiceTier != "" || len(got.CustomArgs) != 0 {
		t.Errorf("service_tier/custom_args = %q/%v, want both dropped on another runtime", got.ServiceTier, got.CustomArgs)
	}
}

func TestTaskRuntimeBound(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	primaryRuntimeID := createClaimReclaimRuntime(t, ctx, "Bound primary")
	fallbackRuntimeID := createClaimReclaimRuntime(t, ctx, "Bound secondary")
	agentID, _ := createClaimReclaimAgentAndIssue(t, ctx, primaryRuntimeID, "Bound agent")
	dbfx.Insert(t, "agent_model_fallback", testutil.Cols{
		"workspace_id": testWorkspaceID, "agent_id": agentID, "position": 1,
		"runtime_id": fallbackRuntimeID, "model": "gpt-5.6-terra",
	})
	agent, err := testHandler.Queries.GetAgent(ctx, util.MustParseUUID(agentID))
	if err != nil {
		t.Fatalf("get agent: %v", err)
	}

	run := func(runtimeID, model string, position int32) db.AgentTaskQueue {
		task := db.AgentTaskQueue{
			RuntimeID: util.MustParseUUID(runtimeID),
			Model:     pgtype.Text{String: model, Valid: model != ""},
		}
		if position != 0 {
			task.FallbackPosition = pgtype.Int4{Int32: position, Valid: true}
		}
		return task
	}
	check := func(name string, task db.AgentTaskQueue, want bool) {
		t.Helper()
		got, err := taskRuntimeBound(ctx, testHandler.Queries, agent, task)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Errorf("%s: bound = %v, want %v", name, got, want)
		}
	}

	check("primary run on the agent's runtime", run(primaryRuntimeID, "", 0), true)
	check("primary run on a fallback-only runtime", run(fallbackRuntimeID, "gpt-5.6-terra", 0), false)
	check("fallback run on its entry", run(fallbackRuntimeID, "gpt-5.6-terra", 1), true)
	check("fallback run with another model", run(fallbackRuntimeID, "gpt-5.5", 1), false)
	check("fallback run on the agent's runtime", run(primaryRuntimeID, "gpt-5.6-terra", 1), false)

	dbfx.Exec(t, `DELETE FROM agent_model_fallback WHERE agent_id = $1`, agentID)
	check("fallback run after its entry is removed", run(fallbackRuntimeID, "gpt-5.6-terra", 1), false)
}
