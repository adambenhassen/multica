-- Issues a member pinned to the top of the Activity feed. Separate from
-- pinned_item, which backs the sidebar's Pinned section.
CREATE TABLE IF NOT EXISTS activity_pin (
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, issue_id)
);
