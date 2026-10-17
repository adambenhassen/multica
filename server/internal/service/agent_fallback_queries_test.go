package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// insertFallbackRuntime adds a public runtime in the agent's workspace, owned
// by the agent's owner, with the given status.
func insertFallbackRuntime(t *testing.T, pool *pgxpool.Pool, agentID, status string) string {
	t.Helper()
	var runtimeID string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, visibility, last_seen_at)
		SELECT a.workspace_id, 'fallback-' || gen_random_uuid()::text, 'cloud', 'codex', $2, 'test', '{}'::jsonb, a.owner_id, 'public', now()
		FROM agent a WHERE a.id = $1
		RETURNING id::text`, agentID, status).Scan(&runtimeID); err != nil {
		t.Fatalf("insert fallback runtime: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM agent_model_fallback WHERE runtime_id = $1`, runtimeID)
		pool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})
	return runtimeID
}

func insertFallback(t *testing.T, pool *pgxpool.Pool, agentID string, position int32, runtimeID, model string, level any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO agent_model_fallback (workspace_id, agent_id, position, runtime_id, model, thinking_level)
		SELECT a.workspace_id, a.id, $2, $3, $4, $5 FROM agent a WHERE a.id = $1`,
		agentID, position, runtimeID, model, level); err != nil {
		t.Fatalf("insert fallback: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM agent_model_fallback WHERE agent_id = $1 AND position = $2`, agentID, position)
	})
}

func TestCreateFallbackTaskSwitchesRuntimeAndModel(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, issueID := seedAttributionFixture(t, pool)
	var primaryRuntimeID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&primaryRuntimeID); err != nil {
		t.Fatalf("read agent runtime: %v", err)
	}
	fallbackRuntimeID := insertFallbackRuntime(t, pool, agentID, "online")

	var parentID pgtype.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, attempt, max_attempts, failure_reason, session_id, work_dir)
		VALUES ($1, $2, $3, 'failed', 0, 2, 2, 'agent_error.provider_quota_limit', 'claude-session', '/tmp/claude-workdir')
		RETURNING id`, agentID, primaryRuntimeID, issueID).Scan(&parentID); err != nil {
		t.Fatalf("insert parent task: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE parent_task_id = $1 OR id = $1`, parentID)
	})

	tests := []struct {
		name        string
		runtimeID   string
		wantWorkDir bool
	}{
		{name: "other runtime starts clean", runtimeID: fallbackRuntimeID, wantWorkDir: false},
		{name: "same runtime keeps the workdir", runtimeID: primaryRuntimeID, wantWorkDir: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			child, err := q.CreateFallbackTask(ctx, db.CreateFallbackTaskParams{
				ID:               parentID,
				RuntimeID:        util.MustParseUUID(tt.runtimeID),
				Model:            "gpt-5.6-terra",
				FallbackPosition: 1,
			})
			if err != nil {
				t.Fatalf("CreateFallbackTask: %v", err)
			}
			t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, child.ID) })

			if util.UUIDToString(child.RuntimeID) != tt.runtimeID {
				t.Errorf("runtime = %s, want %s", util.UUIDToString(child.RuntimeID), tt.runtimeID)
			}
			if child.Model.String != "gpt-5.6-terra" || !child.FallbackPosition.Valid || child.FallbackPosition.Int32 != 1 {
				t.Errorf("model/position = %+v/%+v, want gpt-5.6-terra/1", child.Model, child.FallbackPosition)
			}
			if child.Status != "queued" || child.Attempt != 1 || child.MaxAttempts != 2 {
				t.Errorf("status/attempt/max = %s/%d/%d, want queued/1/2", child.Status, child.Attempt, child.MaxAttempts)
			}
			if child.SessionID.Valid || !child.ForceFreshSession {
				t.Errorf("session = %+v fresh = %v, want no session and a fresh start", child.SessionID, child.ForceFreshSession)
			}
			if child.WorkDir.Valid != tt.wantWorkDir {
				t.Errorf("work_dir = %+v, want carried=%v", child.WorkDir, tt.wantWorkDir)
			}
			if child.RetryOfTaskID != parentID || child.ParentTaskID != parentID {
				t.Errorf("lineage = retry_of %s parent %s, want both %s",
					util.UUIDToString(child.RetryOfTaskID), util.UUIDToString(child.ParentTaskID), util.UUIDToString(parentID))
			}
		})
	}
}

func TestNextOnlineAgentFallbackSkipsOfflineAndEarlierEntries(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, _ := seedAttributionFixture(t, pool)
	offline := insertFallbackRuntime(t, pool, agentID, "offline")
	online := insertFallbackRuntime(t, pool, agentID, "online")
	insertFallback(t, pool, agentID, 1, offline, "gpt-5.6-terra", nil)
	insertFallback(t, pool, agentID, 2, online, "local-qwen", "high")

	next, err := q.NextOnlineAgentFallback(ctx, db.NextOnlineAgentFallbackParams{AgentID: util.MustParseUUID(agentID), AfterPosition: 0})
	if err != nil {
		t.Fatalf("NextOnlineAgentFallback: %v", err)
	}
	if next.Position != 2 || util.UUIDToString(next.RuntimeID) != online || next.ThinkingLevel.String != "high" {
		t.Fatalf("next = %+v, want position 2 on the online runtime with effort high", next)
	}
	if _, err := q.NextOnlineAgentFallback(ctx, db.NextOnlineAgentFallbackParams{AgentID: util.MustParseUUID(agentID), AfterPosition: 2}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("after the last position err = %v, want pgx.ErrNoRows", err)
	}
}

func TestDeleteAgentRuntimeDropsItsFallbacks(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, _ := seedAttributionFixture(t, pool)
	runtimeID := insertFallbackRuntime(t, pool, agentID, "online")
	insertFallback(t, pool, agentID, 1, runtimeID, "gpt-5.6-terra", nil)

	if err := q.DeleteAgentRuntime(ctx, util.MustParseUUID(runtimeID)); err != nil {
		t.Fatalf("DeleteAgentRuntime: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_model_fallback WHERE runtime_id = $1`, runtimeID).Scan(&n); err != nil {
		t.Fatalf("count fallbacks: %v", err)
	}
	if n != 0 {
		t.Fatalf("fallbacks left for deleted runtime = %d, want 0", n)
	}
}

func TestDeleteAgentRuntimesByProfileDropsTheirFallbacks(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	_, _, agentID, _ := seedAttributionFixture(t, pool)
	var profileID, workspaceID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runtime_profile (workspace_id, display_name, protocol_family, command_name, created_by)
		SELECT a.workspace_id, 'fallback-profile', 'codex', 'fallback-profile-' || gen_random_uuid()::text, a.owner_id
		FROM agent a WHERE a.id = $1
		RETURNING id::text, workspace_id::text`, agentID).Scan(&profileID, &workspaceID); err != nil {
		t.Fatalf("insert runtime profile: %v", err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM runtime_profile WHERE id = $1`, profileID) })

	profileRuntime := insertFallbackRuntime(t, pool, agentID, "online")
	otherRuntime := insertFallbackRuntime(t, pool, agentID, "online")
	if _, err := pool.Exec(ctx, `UPDATE agent_runtime SET profile_id = $2 WHERE id = $1`, profileRuntime, profileID); err != nil {
		t.Fatalf("bind runtime to profile: %v", err)
	}
	insertFallback(t, pool, agentID, 1, profileRuntime, "gpt-5.6-terra", nil)
	insertFallback(t, pool, agentID, 2, otherRuntime, "local-qwen", nil)

	deleted, err := q.DeleteAgentRuntimesByProfile(ctx, db.DeleteAgentRuntimesByProfileParams{
		ProfileID:   util.MustParseUUID(profileID),
		WorkspaceID: util.MustParseUUID(workspaceID),
	})
	if err != nil {
		t.Fatalf("DeleteAgentRuntimesByProfile: %v", err)
	}
	if len(deleted) != 1 || util.UUIDToString(deleted[0].ID) != profileRuntime {
		t.Fatalf("deleted runtimes = %+v, want only %s", deleted, profileRuntime)
	}
	var positions []int32
	rows, err := pool.Query(ctx, `SELECT position FROM agent_model_fallback WHERE agent_id = $1 ORDER BY position`, agentID)
	if err != nil {
		t.Fatalf("list fallbacks: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p int32
		if err := rows.Scan(&p); err != nil {
			t.Fatalf("scan fallback: %v", err)
		}
		positions = append(positions, p)
	}
	if len(positions) != 1 || positions[0] != 2 {
		t.Fatalf("fallback positions left = %v, want only [2] (the unrelated runtime's)", positions)
	}
}
