-- Single-statement migration: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction or a multi-command string.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_attachment_audience_item
    ON project_attachment_audience (item_type, item_id);
