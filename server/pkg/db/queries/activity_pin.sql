-- name: ListActivityPins :many
SELECT issue_id FROM activity_pin
WHERE workspace_id = $1 AND user_id = $2
ORDER BY created_at ASC, issue_id ASC;

-- name: CreateActivityPin :exec
INSERT INTO activity_pin (workspace_id, user_id, issue_id)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: DeleteActivityPin :exec
DELETE FROM activity_pin
WHERE workspace_id = $1 AND user_id = $2 AND issue_id = $3;

-- name: DeleteActivityPinsByIssue :exec
DELETE FROM activity_pin
WHERE workspace_id = $1 AND issue_id = $2;
