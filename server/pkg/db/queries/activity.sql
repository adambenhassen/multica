-- name: ListActivitiesForIssue :many
-- The NEWEST $2 activities for an issue, returned in chronological order.
--
-- The cap has to bite at the OLD end, not the new one. The inner query takes
-- the window with the keyset ordering (created_at DESC, id DESC), which
-- idx_activity_log_issue_keyset (migration 068) satisfies without a sort step —
-- it is not an index-only scan, since the index does not cover the columns
-- SELECT * needs, so the heap is still read for the rows in the window. The
-- outer query re-sorts ascending so every caller keeps the chronological
-- contract it already had.
--
-- Capping with ORDER BY created_at ASC instead discards the newest rows, which
-- made a busy issue's timeline appear to stop at some point in the past with no
-- indication anything was missing. Activity is machine-paced (description
-- autosave, every agent run, status/assignee changes), so this was reachable in
-- normal use, not only on pathological issues (MUL-5492).
SELECT * FROM (
    SELECT * FROM activity_log
    WHERE issue_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
) AS recent
ORDER BY created_at ASC, id ASC;

-- name: GetActivity :one
SELECT * FROM activity_log
WHERE id = $1;

-- name: CreateActivity :one
INSERT INTO activity_log (
    workspace_id, issue_id, actor_type, actor_id, action, details, id
) VALUES ($1, $2, $3, $4, $5, $6, COALESCE(sqlc.narg('id')::uuid, gen_random_uuid()))
RETURNING *;

-- name: HasSquadLeaderNoActionEvaluationForTask :one
SELECT EXISTS (
  SELECT 1
  FROM activity_log
  WHERE issue_id = @issue_id
    AND actor_type = 'agent'
    AND actor_id = @agent_id
    AND action = 'squad_leader_evaluated'
    AND details->>'outcome' = 'no_action'
    AND details->>'task_id' = @task_id::text
) AS exists;

-- name: CountAssigneeChangesByActor :many
-- Count how many times a user assigned each target via assignee_changed activities.
SELECT
  details->>'to_type' as assignee_type,
  details->>'to_id' as assignee_id,
  COUNT(*)::bigint as frequency
FROM activity_log
WHERE workspace_id = $1
  AND actor_id = $2
  AND actor_type = 'member'
  AND action = 'assignee_changed'
  AND details->>'to_type' IS NOT NULL
  AND details->>'to_id' IS NOT NULL
GROUP BY details->>'to_type', details->>'to_id';

-- name: ListRecentWorkspaceActivities :many
-- The newest issue activity across a workspace, for the Dashboard feed.
-- Issue-less rows (agent env audit entries) are excluded on purpose: the feed
-- is visible to every member, the audit trail is not. The literal
-- `issue_id IS NOT NULL` predicate lets idx_activity_log_workspace_recent
-- (migration 581) serve the ORDER BY without a sort step.
SELECT a.id, a.workspace_id, a.issue_id, a.actor_type, a.actor_id, a.action, a.details, a.created_at,
       i.number AS issue_number, i.title AS issue_title, i.status AS issue_status
FROM activity_log a
JOIN issue i ON i.id = a.issue_id AND i.workspace_id = a.workspace_id
WHERE a.workspace_id = @workspace_id
  AND a.issue_id IS NOT NULL
  AND NOT (a.action = ANY(@excluded_actions::text[]))
  AND (cardinality(@only_actions::text[]) = 0 OR a.action = ANY(@only_actions::text[]))
  AND (sqlc.narg('before_at')::timestamptz IS NULL
       OR (a.created_at, a.id) < (sqlc.narg('before_at')::timestamptz, sqlc.narg('before_id')::uuid))
ORDER BY a.created_at DESC, a.id DESC
LIMIT @row_limit;

-- name: ListIssuesByStatusEnteredAt :many
-- Issues currently in one of @statuses, newest first by when they entered
-- that status: the latest status_changed activity whose `to` is the issue's
-- current status. Backs the Dashboard's Done / Cancelled tabs, where "recent"
-- means recently completed, not recently touched. An issue with no such row
-- (created directly in the status) falls back to its updated_at.
SELECT i.id, i.number, i.title, i.status,
       COALESCE(entered.created_at, i.updated_at)::timestamptz AS entered_at,
       entered.actor_type, entered.actor_id
FROM issue i
LEFT JOIN LATERAL (
    SELECT a.created_at, a.actor_type, a.actor_id
    FROM activity_log a
    WHERE a.issue_id = i.id
      AND a.action = 'status_changed'
      AND a.details->>'to' = i.status
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
) entered ON true
WHERE i.workspace_id = @workspace_id
  AND i.status = ANY(@statuses::text[])
ORDER BY entered_at DESC, i.id DESC
LIMIT @row_limit OFFSET @row_offset;
