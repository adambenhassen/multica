-- An account that overrides its provider's runtime default: agents left on
-- "Runtime default" run with it. At most one per (workspace, provider),
-- enforced by the partial unique index in 598.
ALTER TABLE agent_account ADD COLUMN IF NOT EXISTS overrides_runtime_default BOOLEAN NOT NULL DEFAULT false;
