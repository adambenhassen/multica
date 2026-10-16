-- The agent's thinking_level as it stood when this run was claimed, so run
-- history keeps the effort a run actually used after the agent setting
-- changes. NULL means the run used the runtime/model default, or was claimed
-- before this column existed.
ALTER TABLE agent_task_queue ADD COLUMN thinking_level TEXT;
