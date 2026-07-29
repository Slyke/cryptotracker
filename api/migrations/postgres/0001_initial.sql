CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  auth_method TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  source_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value_json TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (user_id, setting_key)
);

CREATE TABLE IF NOT EXISTS watched_assets (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  network TEXT,
  contract_or_mint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS selected_quote_currencies (
  user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE IF NOT EXISTS asset_provider_mappings (
  id TEXT PRIMARY KEY,
  canonical_asset_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_asset_id TEXT NOT NULL,
  provider_symbol TEXT,
  pair_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (canonical_asset_id, provider, provider_asset_id, pair_id)
);

CREATE TABLE IF NOT EXISTS asset_lifecycle_events (
  id TEXT PRIMARY KEY,
  source_asset_id TEXT NOT NULL,
  destination_asset_id TEXT,
  event_type TEXT NOT NULL,
  effective_at_ms BIGINT NOT NULL,
  conversion_ratio TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_points (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  canonical_asset_id TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  bucket_start_ms BIGINT NOT NULL,
  granularity_seconds INTEGER NOT NULL,
  data_kind TEXT NOT NULL,
  open_value TEXT,
  high_value TEXT,
  low_value TEXT,
  close_value TEXT NOT NULL,
  volume_value TEXT,
  sample_count INTEGER NOT NULL DEFAULT 1,
  finalized INTEGER NOT NULL DEFAULT 0,
  retrieved_at_ms BIGINT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  disputed INTEGER NOT NULL DEFAULT 0,
  spread_value TEXT,
  contributing_values_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (provider, canonical_asset_id, quote_currency, bucket_start_ms, granularity_seconds, data_kind)
);
CREATE INDEX IF NOT EXISTS market_points_range_idx ON market_points(canonical_asset_id, quote_currency, granularity_seconds, bucket_start_ms);
CREATE INDEX IF NOT EXISTS market_points_provider_idx ON market_points(provider, bucket_start_ms);

CREATE TABLE IF NOT EXISTS market_sync_cursors (
  provider TEXT NOT NULL,
  canonical_asset_id TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  granularity_seconds INTEGER NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  oldest_at_ms BIGINT,
  newest_at_ms BIGINT,
  completeness TEXT NOT NULL DEFAULT 'syncing',
  last_success_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (provider, canonical_asset_id, quote_currency, granularity_seconds)
);

CREATE TABLE IF NOT EXISTS tracked_addresses (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  deleted_at_ms BIGINT,
  UNIQUE (network, normalized_address)
);

CREATE TABLE IF NOT EXISTS address_asset_selections (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES tracked_addresses(id) ON DELETE CASCADE,
  canonical_asset_id TEXT NOT NULL,
  contract_or_mint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (address_id, canonical_asset_id, contract_or_mint)
);

CREATE TABLE IF NOT EXISTS address_sync_state (
  address_id TEXT PRIMARY KEY REFERENCES tracked_addresses(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  oldest_reconstructed_at_ms BIGINT,
  provider_boundary_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  last_success_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_transactions (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES tracked_addresses(id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  block_reference TEXT,
  transaction_position INTEGER,
  occurred_at_ms BIGINT NOT NULL,
  confirmation_state TEXT NOT NULL,
  raw_summary_json TEXT NOT NULL DEFAULT '{}',
  warning_json TEXT,
  UNIQUE (address_id, network, transaction_id)
);
CREATE INDEX IF NOT EXISTS chain_transactions_range_idx ON chain_transactions(address_id, occurred_at_ms);

CREATE TABLE IF NOT EXISTS address_balance_events (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES tracked_addresses(id) ON DELETE CASCADE,
  transaction_id TEXT,
  canonical_asset_id TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  ordering_key TEXT NOT NULL,
  quantity_delta TEXT NOT NULL,
  fee_quantity TEXT,
  event_type TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (address_id, canonical_asset_id, ordering_key, event_type)
);
CREATE INDEX IF NOT EXISTS address_balance_events_range_idx ON address_balance_events(address_id, canonical_asset_id, occurred_at_ms);

CREATE TABLE IF NOT EXISTS address_balance_points (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES tracked_addresses(id) ON DELETE CASCADE,
  canonical_asset_id TEXT NOT NULL,
  bucket_start_ms BIGINT NOT NULL,
  granularity_seconds INTEGER NOT NULL,
  quantity TEXT NOT NULL,
  value_currency TEXT,
  value_amount TEXT,
  price_coverage TEXT NOT NULL DEFAULT 'unpriced',
  source_event_id TEXT,
  UNIQUE (address_id, canonical_asset_id, bucket_start_ms, granularity_seconds)
);

CREATE TABLE IF NOT EXISTS kraken_trades (
  id TEXT PRIMARY KEY,
  kraken_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  asset_in_id TEXT,
  asset_out_id TEXT,
  pair_raw TEXT NOT NULL,
  side TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  cost TEXT,
  fee TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kraken_ledgers (
  id TEXT PRIMARY KEY,
  kraken_id TEXT NOT NULL UNIQUE,
  reference_id TEXT,
  asset_raw TEXT NOT NULL,
  canonical_asset_id TEXT,
  event_type TEXT NOT NULL,
  subtype TEXT,
  occurred_at_ms BIGINT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT,
  transaction_id TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kraken_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms BIGINT NOT NULL UNIQUE,
  total_value_currency TEXT,
  total_value TEXT,
  price_coverage TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kraken_snapshot_balances (
  snapshot_id TEXT NOT NULL REFERENCES kraken_snapshots(id) ON DELETE CASCADE,
  asset_raw TEXT NOT NULL,
  canonical_asset_id TEXT,
  category TEXT NOT NULL,
  quantity TEXT NOT NULL,
  value_currency TEXT,
  value_amount TEXT,
  priced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, asset_raw, category)
);

CREATE TABLE IF NOT EXISTS kraken_margin_positions (
  id TEXT PRIMARY KEY,
  kraken_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  pair_raw TEXT NOT NULL,
  opened_at_ms BIGINT,
  closed_at_ms BIGINT,
  volume TEXT,
  cost TEXT,
  fee TEXT,
  realised_pnl TEXT,
  unrealised_pnl TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS kraken_earn_allocations (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL UNIQUE,
  asset_raw TEXT NOT NULL,
  canonical_asset_id TEXT,
  product_id TEXT,
  quantity TEXT NOT NULL,
  reward_quantity TEXT,
  state TEXT NOT NULL,
  captured_at_ms BIGINT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kraken_sync_cursors (
  endpoint TEXT PRIMARY KEY,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  completeness TEXT NOT NULL DEFAULT 'syncing',
  oldest_at_ms BIGINT,
  newest_at_ms BIGINT,
  last_success_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS internal_transfer_matches (
  id TEXT PRIMARY KEY,
  kraken_ledger_id TEXT NOT NULL,
  chain_transaction_id TEXT,
  address_balance_event_id TEXT,
  canonical_asset_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence TEXT NOT NULL,
  quantity TEXT NOT NULL,
  fee_quantity TEXT,
  evidence_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE (kraken_ledger_id, chain_transaction_id, address_balance_event_id)
);

CREATE TABLE IF NOT EXISTS cost_basis_lots (
  id TEXT PRIMARY KEY,
  calculation_run_id TEXT NOT NULL,
  method TEXT NOT NULL,
  canonical_asset_id TEXT NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  original_quantity TEXT NOT NULL,
  remaining_quantity TEXT NOT NULL,
  basis_currency TEXT NOT NULL,
  basis_amount TEXT,
  basis_known INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calculation_runs (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  currency TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  realised_pnl TEXT,
  unrealised_pnl TEXT,
  basis_coverage_percent TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  started_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT
);

CREATE TABLE IF NOT EXISTS application_exports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  artifact_path TEXT,
  manifest_json TEXT,
  bytes_written BIGINT,
  checksum_sha256 TEXT,
  created_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT,
  expires_at_ms BIGINT,
  last_error_json TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at_ms BIGINT,
  locked_at_ms BIGINT,
  locked_by TEXT,
  last_error_json TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, next_retry_at_ms, priority, created_at_ms);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  occurred_at_ms BIGINT NOT NULL,
  username TEXT,
  auth_method TEXT,
  source_ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_identifier TEXT,
  result TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_range_idx ON audit_log(occurred_at_ms);
