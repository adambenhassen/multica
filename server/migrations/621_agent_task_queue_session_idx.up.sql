-- Single statement: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- or share a multi-command migration file.
--
-- Finds the earlier runs that used a session, which is how a run's usage
-- response tells that it resumed one (ListTaskCarriedOverContext). Without it
-- the lookup filters every run of the agent, which is slow on busy issues.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_task_queue_session
    ON agent_task_queue (session_id) WHERE session_id IS NOT NULL;
