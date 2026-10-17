package handler

import (
	"context"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// taskRuntimeBound reports whether a claimed run may execute on its runtime:
// the agent's own runtime, or, for a fallback run, the runtime of the agent's
// fallback entry at the run's position. Reordering or removing entries makes
// runs queued under the old list fail delivery.
func taskRuntimeBound(ctx context.Context, q *db.Queries, agent db.Agent, task db.AgentTaskQueue) (bool, error) {
	if agent.RuntimeID == task.RuntimeID {
		return true, nil
	}
	if !task.FallbackPosition.Valid {
		return false, nil
	}
	return q.AgentFallbackBindsRuntime(ctx, db.AgentFallbackBindsRuntimeParams{
		AgentID:   agent.ID,
		Position:  task.FallbackPosition.Int32,
		RuntimeID: task.RuntimeID,
	})
}
