CREATE TABLE IF NOT EXISTS asset_catalog (
  canonical_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  network TEXT,
  contract_or_mint TEXT,
  market_cap_rank INTEGER,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS asset_catalog_rank_idx
  ON asset_catalog(market_cap_rank, canonical_id);

CREATE INDEX IF NOT EXISTS asset_catalog_symbol_idx
  ON asset_catalog(symbol, name);
