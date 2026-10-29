CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_account_workspace_name ON agent_account (workspace_id, name);
