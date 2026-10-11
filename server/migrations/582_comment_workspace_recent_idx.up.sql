CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_workspace_recent ON comment (workspace_id, created_at DESC, id DESC) WHERE type = 'comment' AND deleted_at IS NULL;
