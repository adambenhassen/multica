package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestClaimTaskSnapshotsAgentThinkingLevel(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name       string
		agentLevel any
		want       pgtype.Text
	}{
		{name: "pinned level is trimmed", agentLevel: " high ", want: pgtype.Text{String: "high", Valid: true}},
		{name: "blank level is runtime default", agentLevel: "  ", want: pgtype.Text{}},
		{name: "unset level is runtime default", agentLevel: nil, want: pgtype.Text{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newRuntimeClaimAccessFixture(t, "public", true, true, "queued")
			if _, err := fixture.pool.Exec(ctx, `UPDATE agent SET thinking_level = $2 WHERE id = $1`, fixture.agentID, tt.agentLevel); err != nil {
				t.Fatalf("set agent thinking_level: %v", err)
			}
			svc := NewTaskService(db.New(fixture.pool), fixture.pool, nil, events.New())

			claimed, err := svc.ClaimTaskForRuntime(ctx, fixture.runtimeID)
			if err != nil {
				t.Fatalf("claim task: %v", err)
			}
			if claimed == nil {
				t.Fatal("claim returned nil task")
			}
			if claimed.ThinkingLevel != tt.want {
				t.Fatalf("claimed thinking_level = %+v, want %+v", claimed.ThinkingLevel, tt.want)
			}

			// The snapshot must outlive later edits to the agent's setting.
			if _, err := fixture.pool.Exec(ctx, `UPDATE agent SET thinking_level = 'max' WHERE id = $1`, fixture.agentID); err != nil {
				t.Fatalf("change agent thinking_level: %v", err)
			}
			var stored pgtype.Text
			if err := fixture.pool.QueryRow(ctx, `SELECT thinking_level FROM agent_task_queue WHERE id = $1`, fixture.taskID).Scan(&stored); err != nil {
				t.Fatalf("read task thinking_level: %v", err)
			}
			if stored != tt.want {
				t.Fatalf("stored thinking_level after agent edit = %+v, want %+v", stored, tt.want)
			}
		})
	}
}
