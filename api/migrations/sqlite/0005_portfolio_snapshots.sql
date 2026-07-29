CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL UNIQUE,
  primary_currency TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  quantities_json TEXT NOT NULL DEFAULT '{}',
  priced_coverage_percent TEXT NOT NULL,
  incomplete_balance_count INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_time_idx
ON portfolio_snapshots(captured_at_ms);
