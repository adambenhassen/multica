-- A fallback entry may run with a workspace account (e.g. the same Claude
-- runtime on a second subscription). NULL = the runtime default. No foreign
-- key: account deletion is refused while an entry uses it.
ALTER TABLE agent_model_fallback ADD COLUMN IF NOT EXISTS account_id UUID;
