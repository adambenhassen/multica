-- One row per (run, skill): the first time a run's transcript showed the agent
-- loading the skill. Backs the Skills-list RUNS / LAST USED columns.
-- Relationships are validated and cleaned up in application code (no foreign keys).
CREATE TABLE IF NOT EXISTS skill_invocation (
    task_id UUID NOT NULL,
    skill_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, skill_id)
);
