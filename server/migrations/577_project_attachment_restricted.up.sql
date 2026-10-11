-- A project skill / MCP server link reaches every agent in the project unless
-- it is restricted, in which case only the agents (directly, or through a
-- label) listed in project_attachment_audience receive it. A restricted link
-- with no targets reaches nobody: removing the last target never widens it.
ALTER TABLE project_skill ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE project_mcp_server ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE;
