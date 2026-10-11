-- Workspace skills attached to a project. Every task that runs in the project
-- receives these skills in addition to its agent's own skills. Relationships
-- are validated and cleaned up in application code (no foreign keys).
CREATE TABLE IF NOT EXISTS project_skill (
    project_id UUID NOT NULL,
    skill_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, skill_id)
);
