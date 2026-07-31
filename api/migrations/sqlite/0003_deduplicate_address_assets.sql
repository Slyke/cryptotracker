DELETE FROM address_asset_selections
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY address_id, canonical_asset_id, COALESCE(contract_or_mint, '')
        ORDER BY enabled DESC, updated_at_ms DESC, id
      ) AS duplicate_number
    FROM address_asset_selections
  ) AS ranked_selections
  WHERE duplicate_number > 1
);

CREATE UNIQUE INDEX address_asset_selections_currency_idx
ON address_asset_selections(
  address_id,
  canonical_asset_id,
  COALESCE(contract_or_mint, '')
);
