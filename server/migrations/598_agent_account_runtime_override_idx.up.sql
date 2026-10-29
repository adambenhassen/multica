CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_account_runtime_override ON agent_account (workspace_id, provider) WHERE overrides_runtime_default;
