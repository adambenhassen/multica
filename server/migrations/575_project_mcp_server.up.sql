-- Workspace MCP library entries attached to a project. Every task that runs in
-- the project receives these servers in addition to the agent's own, unless
-- the agent has a disabled binding to the same server. Relationships are
-- validated and cleaned up in application code (no foreign keys).
CREATE TABLE IF NOT EXISTS project_mcp_server (
    project_id UUID NOT NULL,
    server_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, server_id)
);
