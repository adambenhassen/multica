package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestFailTaskFallsBackOnProviderFailure(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)
	svc := &TaskService{Queries: q, TxStarter: pool, Bus: events.New()}
	var primaryRuntimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&primaryRuntimeID); err != nil {
		t.Fatalf("read agent runtime: %v", err)
	}
	codex := insertFallbackRuntime(t, pool, agentID, "online")
	local := insertFallbackRuntime(t, pool, agentID, "online")
	insertFallback(t, pool, agentID, 1, codex, "gpt-5.6-terra", nil)
	insertFallback(t, pool, agentID, 2, local, "local-qwen", nil)

	tests := []struct {
		name         string
		reason       string
		runtimeID    string
		position     any // nil = primary
		attempt      int32
		maxAttempts  int32
		autopilot    bool
		wantRuntime  string // "" = no fallback child
		wantModel    string
		wantPosition int32
	}{
		{name: "quota moves to the first fallback", reason: "agent_error.provider_quota_limit", runtimeID: primaryRuntimeID, attempt: 1, maxAttempts: 2, wantRuntime: codex, wantModel: "gpt-5.6-terra", wantPosition: 1},
		{name: "auth on fallback 1 moves to fallback 2", reason: "agent_error.provider_auth_or_access", runtimeID: codex, position: int32(1), attempt: 1, maxAttempts: 2, wantRuntime: local, wantModel: "local-qwen", wantPosition: 2},
		{name: "last fallback fails normally", reason: "agent_error.model_not_found_or_unavailable", runtimeID: local, position: int32(2), attempt: 1, maxAttempts: 2},
		{name: "non-provider failure never falls back", reason: "agent_error.unknown", runtimeID: primaryRuntimeID, attempt: 1, maxAttempts: 2},
		{name: "network falls back only after its retries", reason: "agent_error.provider_network", runtimeID: primaryRuntimeID, attempt: 3, maxAttempts: 3, wantRuntime: codex, wantModel: "gpt-5.6-terra", wantPosition: 1},
		{name: "disabled retry disables fallback", reason: "agent_error.provider_quota_limit", runtimeID: primaryRuntimeID, attempt: 1, maxAttempts: 1},
		{name: "autopilot runs are excluded", reason: "agent_error.provider_quota_limit", runtimeID: primaryRuntimeID, attempt: 1, maxAttempts: 2, autopilot: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var autopilotRunID any
			if tt.autopilot {
				autopilotRunID = seedAutopilotRunForFallbackTest(t, pool, agentID)
			}
			var parentID pgtype.UUID
			if err := pool.QueryRow(ctx, `
				INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, attempt, max_attempts, fallback_position, autopilot_run_id, session_id, work_dir)
				VALUES ($1, $2, $3, 'running', 0, $4, $5, $6, $7, 'src-session', '/tmp/src-workdir')
				RETURNING id`, agentID, tt.runtimeID, issueID, tt.attempt, tt.maxAttempts, tt.position, autopilotRunID).Scan(&parentID); err != nil {
				t.Fatalf("insert parent: %v", err)
			}
			t.Cleanup(func() {
				pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE parent_task_id = $1 OR id = $1`, parentID)
			})

			if _, err := svc.FailTask(ctx, parentID, "provider failure", "src-session", "/tmp/src-workdir", "", tt.reason, false, "", ""); err != nil {
				t.Fatalf("FailTask: %v", err)
			}

			var (
				n        int
				runtime  string
				model    pgtype.Text
				position pgtype.Int4
			)
			if err := pool.QueryRow(ctx, `
				SELECT count(*) OVER (), runtime_id::text, model, fallback_position
				FROM agent_task_queue WHERE parent_task_id = $1 LIMIT 1`, parentID).Scan(&n, &runtime, &model, &position); err != nil {
				if tt.wantRuntime == "" {
					return // no child row: expected
				}
				t.Fatalf("read child: %v", err)
			}
			if tt.wantRuntime == "" {
				t.Fatalf("got a child on %s, want none", runtime)
			}
			if n != 1 || runtime != tt.wantRuntime || model.String != tt.wantModel || position.Int32 != tt.wantPosition {
				t.Fatalf("child = n%d %s %q pos %d, want 1 %s %q pos %d", n, runtime, model.String, position.Int32, tt.wantRuntime, tt.wantModel, tt.wantPosition)
			}
		})
	}
}

func seedAutopilotRunForFallbackTest(t *testing.T, pool *pgxpool.Pool, agentID string) string {
	t.Helper()
	ctx := context.Background()
	var autopilotID, runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO autopilot (workspace_id, title, assignee_id, execution_mode, created_by_type, created_by_id)
		SELECT a.workspace_id, 'fallback-autopilot', a.id, 'run_only', 'member', a.owner_id FROM agent a WHERE a.id = $1
		RETURNING id`, agentID).Scan(&autopilotID); err != nil {
		t.Fatalf("seed autopilot: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO autopilot_run (autopilot_id, source, status) VALUES ($1, 'manual', 'running') RETURNING id`,
		autopilotID).Scan(&runID); err != nil {
		t.Fatalf("seed autopilot run: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE autopilot_run_id = $1`, runID)
		pool.Exec(context.Background(), `DELETE FROM autopilot_run WHERE id = $1`, runID)
		pool.Exec(context.Background(), `DELETE FROM autopilot WHERE id = $1`, autopilotID)
	})
	return runID
}
