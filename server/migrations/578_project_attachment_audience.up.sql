-- Who a restricted project skill / MCP server link reaches. Targets are agents
-- or agent labels. No foreign keys: rows are validated and cleaned up in
-- application code.
CREATE TABLE IF NOT EXISTS project_attachment_audience (
    project_id UUID NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('skill', 'mcp_server')),
    item_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'label')),
    target_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, item_type, item_id, target_type, target_id)
);
