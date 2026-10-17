-- Ordered model fallbacks for an agent. When a run fails because of its
-- provider, the next entry's runtime and model run it again. Position 0 is the
-- agent's own runtime and model and is never stored. No foreign keys:
-- relationships are validated and cleaned up in application code.
CREATE TABLE IF NOT EXISTS agent_model_fallback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    position INT NOT NULL CHECK (position BETWEEN 1 AND 4),
    runtime_id UUID NOT NULL,
    model TEXT NOT NULL CHECK (btrim(model) <> ''),
    -- NULL = the runtime/model default; never inherits the agent's level.
    thinking_level TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
