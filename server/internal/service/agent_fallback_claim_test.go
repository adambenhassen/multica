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
