CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_workspace_recent ON activity_log (workspace_id, created_at DESC, id DESC) WHERE issue_id IS NOT NULL;
