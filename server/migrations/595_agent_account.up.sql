-- Workspace-level accounts: a named set of env vars for one provider, e.g.
-- two Claude subscriptions with different CLAUDE_CODE_OAUTH_TOKEN values.
-- env uses the same JSONB encoding and secret handling as agent.custom_env.
-- No foreign keys: agent.account_id is validated and cleaned up in
-- application code.
CREATE TABLE IF NOT EXISTS agent_account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
    env JSONB NOT NULL DEFAULT '{}',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent ADD COLUMN IF NOT EXISTS account_id UUID;
