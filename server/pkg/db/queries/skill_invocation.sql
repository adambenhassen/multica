-- name: CreateSkillInvocations :exec
-- Records that a run loaded these skills. The first detection in a run wins;
-- later batches of the same run that load the skill again are no-ops.
INSERT INTO skill_invocation (task_id, skill_id, workspace_id, agent_id)
SELECT sqlc.arg('task_id')::uuid, s.skill_id, sqlc.arg('workspace_id')::uuid, sqlc.arg('agent_id')::uuid
FROM unnest(sqlc.arg('skill_ids')::uuid[]) AS s(skill_id)
ON CONFLICT (task_id, skill_id) DO NOTHING;

-- name: GetWorkspaceSkillUsage :many
-- Per-skill RUNS (runs in the trailing 30 days that loaded the skill) and
-- LAST USED (newest load ever, so a skill idle past the window still shows
-- when it last ran). Skills never loaded have no row.
SELECT
    skill_id,
    (COUNT(*) FILTER (WHERE invoked_at > now() - INTERVAL '30 days'))::int AS run_count,
    MAX(invoked_at)::timestamptz AS last_used_at
FROM skill_invocation
WHERE workspace_id = $1
GROUP BY skill_id;

-- name: GetSkillUsageByAgent :many
-- One skill's usage split by the agent whose run loaded it: RUNS in the
-- trailing 30 days and LAST USED (newest load ever). Agents that never loaded
-- the skill have no row.
SELECT
    agent_id,
    (COUNT(*) FILTER (WHERE invoked_at > now() - INTERVAL '30 days'))::int AS run_count,
    MAX(invoked_at)::timestamptz AS last_used_at
FROM skill_invocation
WHERE workspace_id = $1 AND skill_id = $2
GROUP BY agent_id;
