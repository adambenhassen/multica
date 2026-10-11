-- Audience of restricted project skill / MCP server links

-- name: ListProjectAttachmentAudience :many
SELECT item_type, item_id, target_type, target_id
FROM project_attachment_audience
WHERE project_id = $1 AND workspace_id = $2
ORDER BY item_type, item_id, target_type, target_id;

-- name: DeleteProjectAttachmentAudience :exec
-- Clears one link's audience (before replacing it, or when the link goes).
DELETE FROM project_attachment_audience
WHERE project_id = $1 AND item_type = $2 AND item_id = $3 AND workspace_id = $4;

-- name: AddProjectAttachmentAudienceTarget :exec
INSERT INTO project_attachment_audience (project_id, item_type, item_id, target_type, target_id, workspace_id)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT DO NOTHING;

-- name: CountLiveAgentsInWorkspace :one
-- Audience validation: every target agent must be a live agent of this
-- workspace.
SELECT count(*) FROM agent
WHERE id = ANY(sqlc.arg('agent_ids')::uuid[])
  AND workspace_id = sqlc.arg('workspace_id')
  AND archived_at IS NULL;

-- name: CountAgentLabelsInWorkspace :one
-- Audience validation: every target label must be an agent label of this
-- workspace.
SELECT count(*) FROM issue_label
WHERE id = ANY(sqlc.arg('label_ids')::uuid[])
  AND workspace_id = sqlc.arg('workspace_id')
  AND resource_type = 'agent';

-- name: IsLabelInProjectAudience :one
-- Agent owners may label their own agents, so attaching a label that grants a
-- restricted project skill / MCP server is gated to workspace admins.
SELECT EXISTS (
    SELECT 1 FROM project_attachment_audience
    WHERE target_type = 'label' AND target_id = $1 AND workspace_id = $2
);
