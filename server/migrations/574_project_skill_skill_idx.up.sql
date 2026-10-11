-- Single-statement migration: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction or a multi-command string.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_skill_skill
    ON project_skill (skill_id);
