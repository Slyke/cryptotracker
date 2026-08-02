CREATE INDEX IF NOT EXISTS market_points_asset_quote_time_idx
ON market_points(canonical_asset_id, quote_currency, bucket_start_ms);

CREATE INDEX IF NOT EXISTS market_points_disputed_asset_time_idx
ON market_points(canonical_asset_id, bucket_start_ms)
WHERE disputed = 1;
