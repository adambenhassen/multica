package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestClaimFallbackRunOnListedRuntime(t *testing.T) {
	ctx := context.Background()
	fixture := newRuntimeClaimAccessFixture(t, "public", true, true, "completed")
	agentID := util.UUIDToString(fixture.agentID)
	fallbackRuntimeID := insertFallbackRuntime(t, fixture.pool, agentID, "online")
	insertFallback(t, fixture.pool, agentID, 1, fallbackRuntimeID, "gpt-5.6-terra", " xhigh ")
	if _, err := fixture.pool.Exec(ctx, `UPDATE agent SET thinking_level = 'max' WHERE id = $1`, fixture.agentID); err != nil {
		t.Fatalf("set agent level: %v", err)
	}
	svc := NewTaskService(db.New(fixture.pool), fixture.pool, nil, events.New())

	newFallbackTask := func() string {
		var id string
		if err := fixture.pool.QueryRow(ctx, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, model, fallback_position)
			SELECT agent_id, $2, issue_id, 'queued', 0, 'gpt-5.6-terra', 1 FROM agent_task_queue WHERE id = $1
			RETURNING id::text`, fixture.taskID, fallbackRuntimeID).Scan(&id); err != nil {
			t.Fatalf("insert fallback task: %v", err)
		}
		t.Cleanup(func() { fixture.pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, id) })
		return id
	}

	taskID := newFallbackTask()
	claimed, err := svc.ClaimTaskForRuntime(ctx, util.MustParseUUID(fallbackRuntimeID))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claimed == nil || util.UUIDToString(claimed.ID) != taskID {
		t.Fatalf("claimed = %+v, want fallback task %s", claimed, taskID)
	}
	if claimed.ThinkingLevel != (pgtype.Text{String: "xhigh", Valid: true}) {
		t.Fatalf("thinking_level = %+v, want the entry's xhigh, not the agent's max", claimed.ThinkingLevel)
	}

	// Only one pending run per issue and agent may exist.
	if _, err := fixture.pool.Exec(ctx, `UPDATE agent_task_queue SET status = 'completed' WHERE id = $1`, taskID); err != nil {
		t.Fatalf("settle first run: %v", err)
	}

	// Removing the entry stops runs queued under it.
	if _, err := fixture.pool.Exec(ctx, `DELETE FROM agent_model_fallback WHERE agent_id = $1`, fixture.agentID); err != nil {
		t.Fatalf("remove entry: %v", err)
	}
	newFallbackTask()
	again, err := svc.ClaimTaskForRuntime(ctx, util.MustParseUUID(fallbackRuntimeID))
	if err != nil {
		t.Fatalf("claim after removal: %v", err)
	}
	if again != nil {
		t.Fatalf("claimed %s after its fallback entry was removed", util.UUIDToString(again.ID))
	}
}

// insertQueuedRun queues a run for the fixture's issue and agent. Only one
// pending run per issue and agent may exist, so callers settle the previous one first.
func insertQueuedRun(t *testing.T, f runtimeClaimAccessFixture, runtimeID, model string, position any) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, model, fallback_position)
		SELECT agent_id, $2, issue_id, 'queued', 0, $3, $4 FROM agent_task_queue WHERE id = $1
		RETURNING id::text`, f.taskID, runtimeID, model, position).Scan(&id); err != nil {
		t.Fatalf("insert queued run: %v", err)
	}
	t.Cleanup(func() { f.pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, id) })
	return id
}

func settleRun(t *testing.T, f runtimeClaimAccessFixture, taskID string) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), `UPDATE agent_task_queue SET status = 'completed' WHERE id = $1`, taskID); err != nil {
		t.Fatalf("settle run: %v", err)
	}
}

// TestClaimFallbackBindingIsExact checks the ClaimAgentTask fence: a run with a
// fallback position is bound only by its own list entry (runtime and model),
// never by the agent's runtime; a run without one only by the agent's runtime.
func TestClaimFallbackBindingIsExact(t *testing.T) {
	ctx := context.Background()
	claim := func(f runtimeClaimAccessFixture, runtimeID string) *db.AgentTaskQueue {
		t.Helper()
		svc := NewTaskService(db.New(f.pool), f.pool, nil, events.New())
		got, err := svc.claimTask(ctx, f.agentID, util.MustParseUUID(runtimeID), claimScope{claimPath: claimPathRuntime})
		if err != nil {
			t.Fatalf("claim: %v", err)
		}
		return got
	}
	newFixture := func() runtimeClaimAccessFixture {
		return newRuntimeClaimAccessFixture(t, "public", true, true, "completed")
	}

	t.Run("primary run on a runtime only in the fallback list is not claimed", func(t *testing.T) {
		f := newFixture()
		agentID := util.UUIDToString(f.agentID)
		listed := insertFallbackRuntime(t, f.pool, agentID, "online")
		insertFallback(t, f.pool, agentID, 1, listed, "gpt-5.6-terra", nil)
		insertQueuedRun(t, f, listed, "gpt-5.6-terra", nil)
		if got := claim(f, listed); got != nil {
			t.Fatalf("claimed primary run %s on a fallback-only runtime", util.UUIDToString(got.ID))
		}
	})

	t.Run("fallback run whose position points at another runtime is not claimed", func(t *testing.T) {
		f := newFixture()
		agentID := util.UUIDToString(f.agentID)
		listed := insertFallbackRuntime(t, f.pool, agentID, "online")
		insertFallback(t, f.pool, agentID, 1, listed, "gpt-5.6-terra", nil)
		own := util.UUIDToString(f.runtimeID)
		insertQueuedRun(t, f, own, "gpt-5.6-terra", 1)
		if got := claim(f, own); got != nil {
			t.Fatalf("claimed fallback run %s outside its entry's runtime", util.UUIDToString(got.ID))
		}
	})

	t.Run("fallback run on the agent's own runtime needs its entry", func(t *testing.T) {
		f := newFixture()
		agentID := util.UUIDToString(f.agentID)
		own := util.UUIDToString(f.runtimeID)
		insertFallback(t, f.pool, agentID, 1, own, "gpt-5.6-terra", nil)

		first := insertQueuedRun(t, f, own, "gpt-5.6-terra", 1)
		got := claim(f, own)
		if got == nil || util.UUIDToString(got.ID) != first {
			t.Fatalf("claimed %+v, want same-runtime fallback run %s", got, first)
		}
		settleRun(t, f, first)

		if _, err := f.pool.Exec(ctx, `DELETE FROM agent_model_fallback WHERE agent_id = $1`, f.agentID); err != nil {
			t.Fatalf("remove entry: %v", err)
		}
		insertQueuedRun(t, f, own, "gpt-5.6-terra", 1)
		if got := claim(f, own); got != nil {
			t.Fatalf("claimed %s after its entry was removed, via the agent's own runtime", util.UUIDToString(got.ID))
		}
	})

	t.Run("fallback run with another model than its entry is not claimed", func(t *testing.T) {
		f := newFixture()
		agentID := util.UUIDToString(f.agentID)
		listed := insertFallbackRuntime(t, f.pool, agentID, "online")
		insertFallback(t, f.pool, agentID, 1, listed, "gpt-5.6-terra", nil)
		insertQueuedRun(t, f, listed, "gpt-5.5", 1)
		if got := claim(f, listed); got != nil {
			t.Fatalf("claimed %s with a model the entry no longer lists", util.UUIDToString(got.ID))
		}
	})
}
