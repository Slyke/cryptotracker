CREATE TABLE IF NOT EXISTS kraken_earn_strategy_rates (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  asset_raw TEXT NOT NULL,
  canonical_asset_id TEXT,
  captured_at_ms BIGINT NOT NULL,
  apr_low_percent TEXT NOT NULL,
  apr_high_percent TEXT NOT NULL,
  apy_low_percent TEXT NOT NULL,
  apy_high_percent TEXT NOT NULL,
  auto_compound INTEGER NOT NULL DEFAULT 0,
  payout_frequency_seconds INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (strategy_id, captured_at_ms)
);

CREATE INDEX IF NOT EXISTS kraken_earn_strategy_rates_asset_time_idx
ON kraken_earn_strategy_rates(canonical_asset_id, captured_at_ms);
