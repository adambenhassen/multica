CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_model_fallback_agent_position ON agent_model_fallback (agent_id, position);
