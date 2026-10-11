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

-- name: ListAgentProjectSkills :many
-- Every project skill that reaches this agent (one row per skill + project),
-- for the agent's Skills tab. Same audience rule as the claim path; the
-- agent's own disabled toggle is applied by the caller so the UI can show it.
SELECT s.id, s.workspace_id, s.name, s.description, s.config, s.created_by, s.created_at, s.updated_at,
       p.id AS project_id, p.title AS project_title
FROM project_skill ps
JOIN skill s ON s.id = ps.skill_id AND s.workspace_id = ps.workspace_id
JOIN project p ON p.id = ps.project_id AND p.workspace_id = ps.workspace_id
WHERE ps.workspace_id = sqlc.arg('workspace_id')
  AND (ps.restricted = FALSE
    OR EXISTS (
      SELECT 1 FROM project_attachment_audience paa
      WHERE paa.project_id = ps.project_id
        AND paa.workspace_id = ps.workspace_id
        AND paa.item_type = 'skill'
        AND paa.item_id = s.id
        AND ((paa.target_type = 'agent' AND paa.target_id = sqlc.arg('agent_id'))
          OR (paa.target_type = 'label' AND paa.target_id IN (
                SELECT atl.label_id FROM agent_to_label atl WHERE atl.agent_id = sqlc.arg('agent_id'))))
    ))
ORDER BY s.name ASC, p.title ASC;

-- name: ListAgentProjectMcpServers :many
-- Every project MCP server that reaches this agent (one row per server +
-- project), for the agent's MCP tab. Returns config only for server-side
-- projection; the HTTP layer never serializes it.
SELECT sqlc.embed(s), p.id AS project_id, p.title AS project_title
FROM project_mcp_server pms
JOIN workspace_mcp_server s ON s.id = pms.server_id AND s.workspace_id = pms.workspace_id
JOIN project p ON p.id = pms.project_id AND p.workspace_id = pms.workspace_id
WHERE pms.workspace_id = sqlc.arg('workspace_id')
  AND (pms.restricted = FALSE
    OR EXISTS (
      SELECT 1 FROM project_attachment_audience paa
      WHERE paa.project_id = pms.project_id
        AND paa.workspace_id = pms.workspace_id
        AND paa.item_type = 'mcp_server'
        AND paa.item_id = s.id
        AND ((paa.target_type = 'agent' AND paa.target_id = sqlc.arg('agent_id'))
          OR (paa.target_type = 'label' AND paa.target_id IN (
                SELECT atl.label_id FROM agent_to_label atl WHERE atl.agent_id = sqlc.arg('agent_id'))))
    ))
ORDER BY s.name ASC, p.title ASC;
