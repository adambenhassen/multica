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
SELECT s.*
FROM workspace_mcp_server s
JOIN project_mcp_server pms ON pms.server_id = s.id
WHERE pms.project_id = $1
  AND pms.workspace_id = $2
  AND s.workspace_id = $2
ORDER BY s.name ASC;

-- name: AddProjectMcpServer :execrows
INSERT INTO project_mcp_server (project_id, server_id, workspace_id, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: RemoveProjectMcpServer :execrows
DELETE FROM project_mcp_server
WHERE project_id = $1 AND server_id = $2 AND workspace_id = $3;

-- name: DeleteProjectMcpServersByServer :exec
-- project_mcp_server has no FK, so removing a library entry sweeps it in the
-- same transaction as the delete (after LockWorkspaceMcpServerForUpdate).
DELETE FROM project_mcp_server WHERE server_id = $1 AND workspace_id = $2;
