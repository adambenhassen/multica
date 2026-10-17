package handler

import (
	"context"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// taskRuntimeBound reports whether a claimed run may execute on its runtime:
// a primary run is bound only by the agent's own runtime; a fallback run only
// by the agent's fallback entry at the run's position, matching runtime and
// model. Reordering, editing or removing entries makes runs queued under the
// old list fail delivery.
func taskRuntimeBound(ctx context.Context, q *db.Queries, agent db.Agent, task db.AgentTaskQueue) (bool, error) {
	if task.FallbackPosition.Valid {
		return q.AgentFallbackBindsRuntime(ctx, db.AgentFallbackBindsRuntimeParams{
			AgentID:   agent.ID,
			Position:  task.FallbackPosition.Int32,
			RuntimeID: task.RuntimeID,
			Model:     task.Model.String,
		})
	}
	return agent.RuntimeID == task.RuntimeID, nil
}
