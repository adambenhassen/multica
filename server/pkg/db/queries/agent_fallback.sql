-- name: ListAgentFallbacks :many
SELECT * FROM agent_model_fallback
WHERE agent_id = $1
ORDER BY position;

-- name: DeleteAgentFallbacks :exec
DELETE FROM agent_model_fallback WHERE agent_id = $1;

-- name: InsertAgentFallback :one
INSERT INTO agent_model_fallback (workspace_id, agent_id, position, runtime_id, model, thinking_level)
VALUES (@workspace_id, @agent_id, @position, @runtime_id, @model, sqlc.narg('thinking_level'))
RETURNING *;

-- name: NextOnlineAgentFallback :one
-- The first fallback after a failed run's position whose runtime is online.
-- An offline runtime is skipped rather than queued behind: the run would wait
-- for it while a later entry could take it now.
SELECT f.* FROM agent_model_fallback f
JOIN agent_runtime r ON r.id = f.runtime_id
WHERE f.agent_id = @agent_id
  AND f.position > @after_position::int
  AND r.status = 'online'
ORDER BY f.position
LIMIT 1;

-- name: AgentFallbackBindsRuntime :one
-- Whether a fallback run's runtime and model are still the agent's entry at
-- that position. Reordering, editing or removing entries stops runs queued
-- under the old list.
SELECT EXISTS (
    SELECT 1 FROM agent_model_fallback
    WHERE agent_id = @agent_id AND position = @position::int
      AND runtime_id = @runtime_id AND model = @model
) AS bound;

-- name: CancelUnboundQueuedFallbackTasks :many
-- Cancels the agent's not-yet-dispatched fallback runs whose entry (position,
-- runtime, model) is no longer in the list. The claim would refuse them
-- forever while they hold the pending slot and absorb new comments.
UPDATE agent_task_queue t
SET status = 'cancelled', completed_at = now(), prepare_lease_expires_at = NULL,
    cancelled_by_type = 'system', cancelled_by_id = NULL, cancelled_by_name = NULL
WHERE t.agent_id = @agent_id
  AND t.status IN ('queued', 'deferred')
  AND t.fallback_position IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_model_fallback f
    WHERE f.agent_id = t.agent_id
      AND f.position = t.fallback_position
      AND f.runtime_id = t.runtime_id
      AND f.model = t.model
  )
RETURNING t.*;

-- name: CreateFallbackTask :one
-- Re-runs a provider-failed attempt on the agent's next fallback (runtime,
-- model). Same lineage, attribution and pending-slot rules as CreateRetryTask,
-- except: runtime and model come from the entry; the session never carries
-- over (a Claude session cannot resume on Codex); work_dir carries over only
-- on the same runtime; attempt restarts at 1 so the fallback run gets its own
-- infra-retry budget. Always created 'queued'.
INSERT INTO agent_task_queue (
    agent_id, runtime_id, issue_id, chat_session_id, autopilot_run_id,
    status, priority, trigger_comment_id, coalesced_comment_ids, trigger_summary, context,
    session_id, work_dir,
    attempt, max_attempts, parent_task_id, force_fresh_session, is_leader_task,
    squad_id, originator_user_id, accountable_user_id, runtime_mcp_overlay, runtime_connected_apps,
    originator_source, delegated_from_task_id, rule_version_id,
    trigger_evidence_kind, trigger_evidence_ref_id, retry_of_task_id,
    chat_input_task_id,
    channel_context_revision, handoff_note, workflow_step,
    model, fallback_position, id
)
SELECT
    p.agent_id, sqlc.arg('runtime_id')::uuid, p.issue_id, p.chat_session_id, p.autopilot_run_id,
    'queued',
    CASE WHEN p.chat_session_id IS NOT NULL THEN GREATEST(p.priority, 3) ELSE p.priority END,
    p.trigger_comment_id, p.coalesced_comment_ids, p.trigger_summary, p.context,
    NULL,
    CASE WHEN p.runtime_id = sqlc.arg('runtime_id')::uuid THEN p.work_dir END,
    1, p.max_attempts, p.id, TRUE, p.is_leader_task,
    p.squad_id,
    p.originator_user_id,
    p.accountable_user_id,
    sqlc.narg(runtime_mcp_overlay),
    sqlc.narg(runtime_connected_apps),
    p.originator_source, p.delegated_from_task_id, p.rule_version_id,
    p.trigger_evidence_kind, p.trigger_evidence_ref_id, p.id,
    p.chat_input_task_id,
    p.channel_context_revision,
    CASE WHEN p.context->>'wakeup_id' IS NOT NULL OR p.workflow_step IS NOT NULL THEN p.handoff_note END,
    p.workflow_step,
    sqlc.arg('model')::text, sqlc.arg('fallback_position')::int,
    COALESCE(sqlc.narg('new_task_id')::uuid, gen_random_uuid())
FROM agent_task_queue p
WHERE p.id = sqlc.arg('id')
  AND lock_task_owner_rows(p.agent_id, p.issue_id, sqlc.arg('runtime_id')::uuid)
ON CONFLICT (issue_id, agent_id, (COALESCE(comment_thread_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE status IN ('queued', 'dispatched')
       OR (status = 'deferred' AND context->>'channel_issue_media_pending' = 'true')
DO NOTHING
RETURNING *;
