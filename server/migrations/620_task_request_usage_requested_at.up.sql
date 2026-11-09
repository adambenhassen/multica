-- When the request was made, from the telemetry record or transcript. It
-- orders a run's requests, so the first one shows how much earlier context a
-- resumed session reloaded. NULL for rows stored before this column existed.
ALTER TABLE task_request_usage ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
