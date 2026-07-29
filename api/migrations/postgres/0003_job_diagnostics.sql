CREATE INDEX IF NOT EXISTS jobs_status_updated_idx
ON jobs(status, updated_at_ms DESC);
