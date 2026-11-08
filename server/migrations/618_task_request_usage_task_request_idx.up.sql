-- Single statement: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- or share a multi-command migration file.
--
-- Deduplicates telemetry retries and repeated backfills (ON CONFLICT on
-- task_id, request_key) and serves the per-task sums behind the cost refresh.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_task_request_usage_task_request
    ON task_request_usage (task_id, request_key);
