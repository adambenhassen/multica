-- A fallback run's model (NULL = use the agent's model, as every other run)
-- and its 1-based position in the agent's fallback list (NULL = primary).
ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS model TEXT, ADD COLUMN IF NOT EXISTS fallback_position INT;
