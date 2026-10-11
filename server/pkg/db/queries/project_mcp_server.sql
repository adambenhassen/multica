-- Project-MCP-server junction

-- name: ListProjectMcpServersForAgent :many
-- Claim path. Both sides are workspace-scoped, so a corrupt project reference
-- cannot lift another tenant's server into a run. A server the agent has bound
-- but disabled stays off: the agent owner's opt-out wins over the project.
SELECT s.name, s.config
FROM workspace_mcp_server s
JOIN project_mcp_server pms ON pms.server_id = s.id
WHERE pms.project_id = sqlc.arg('project_id')
  AND pms.workspace_id = sqlc.arg('workspace_id')
  AND s.workspace_id = sqlc.arg('workspace_id')
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
  AND NOT EXISTS (
    SELECT 1 FROM agent_mcp_server ams
    WHERE ams.agent_id = sqlc.arg('agent_id')
      AND ams.server_id = s.id
      AND ams.enabled = FALSE
  )
ORDER BY s.name ASC;

-- name: ListProjectMcpServers :many
-- Every server attached to the project, for the project page. Returns config
-- only for server-side projection; the HTTP layer never serializes it.
SELECT sqlc.embed(s), pms.restricted
FROM workspace_mcp_server s
JOIN project_mcp_server pms ON pms.server_id = s.id
WHERE pms.project_id = $1
  AND pms.workspace_id = $2
  AND s.workspace_id = $2
ORDER BY s.name ASC;

-- name: CountWorkspaceMcpServerProjects :many
-- How many projects each library entry is attached to, for the workspace
-- settings list, so an entry used only by projects does not look unused.
SELECT server_id, COUNT(*)::bigint AS project_count
FROM project_mcp_server
WHERE workspace_id = $1
GROUP BY server_id;

-- name: AddProjectMcpServer :execrows
INSERT INTO project_mcp_server (project_id, server_id, workspace_id, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: SetProjectMcpServerRestricted :execrows
UPDATE project_mcp_server SET restricted = sqlc.arg('restricted')
WHERE project_id = sqlc.arg('project_id') AND server_id = sqlc.arg('server_id') AND workspace_id = sqlc.arg('workspace_id');

-- name: RemoveProjectMcpServer :execrows
-- The link's audience has no FK, so it goes in the same statement.
WITH deleted_audience AS (
    DELETE FROM project_attachment_audience
    WHERE project_attachment_audience.project_id = $1
      AND project_attachment_audience.item_type = 'mcp_server'
      AND project_attachment_audience.item_id = $2
      AND project_attachment_audience.workspace_id = $3
)
DELETE FROM project_mcp_server
WHERE project_mcp_server.project_id = $1 AND project_mcp_server.server_id = $2 AND project_mcp_server.workspace_id = $3;

-- name: DeleteProjectMcpServersByServer :exec
-- project_mcp_server and its audience have no FK, so removing a library entry
-- sweeps both in the same transaction as the delete (after
-- LockWorkspaceMcpServerForUpdate).
WITH deleted_audience AS (
    DELETE FROM project_attachment_audience
    WHERE project_attachment_audience.item_type = 'mcp_server'
      AND project_attachment_audience.item_id = $1
      AND project_attachment_audience.workspace_id = $2
)
DELETE FROM project_mcp_server WHERE project_mcp_server.server_id = $1 AND project_mcp_server.workspace_id = $2;
