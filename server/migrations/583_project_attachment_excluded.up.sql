-- A project skill / MCP server link can also reach every agent in the project
-- except its audience (agents, or agents carrying a listed label in
-- project_attachment_audience). At most one of restricted and excluded is set;
-- the handler writes both together. An excluded link with no targets reaches
-- everyone.
ALTER TABLE project_skill ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE project_mcp_server ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE;
