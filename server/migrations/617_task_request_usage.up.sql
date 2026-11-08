-- One row per model API request, from the agent CLI's own telemetry (Claude
-- Code, Codex) or a Claude Code transcript backfill. A single request knows
-- its prompt size and cache-write lifetime, which aggregated task_usage rows
-- do not, so its list price is exact. task_usage.cost_usd_ticks is recomputed
-- from these rows. cache_write_tokens counts every write; cost_usd_ticks
-- already prices them by lifetime.
CREATE TABLE IF NOT EXISTS task_request_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL,
    request_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd_ticks BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
