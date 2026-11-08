-- Per-agent opt-in: a follow-up run on an issue starts a new provider session
-- instead of resuming when the agent's last run there ended long enough ago
-- that the provider's prompt cache has expired (see the claim handler).
ALTER TABLE agent ADD COLUMN IF NOT EXISTS fresh_session_when_idle BOOLEAN NOT NULL DEFAULT FALSE;
