-- Single-statement migration: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction or a multi-command string.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skill_invocation_workspace_skill
    ON skill_invocation (workspace_id, skill_id, invoked_at);
