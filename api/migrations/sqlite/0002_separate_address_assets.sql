CREATE TABLE tracked_addresses_separate_assets (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);

INSERT INTO tracked_addresses_separate_assets(
  id, network, address, normalized_address, label, enabled,
  created_at_ms, updated_at_ms, deleted_at_ms
)
SELECT
  id, network, address, normalized_address, label, enabled,
  created_at_ms, updated_at_ms, deleted_at_ms
FROM tracked_addresses;

DROP TABLE tracked_addresses;
ALTER TABLE tracked_addresses_separate_assets RENAME TO tracked_addresses;

CREATE INDEX tracked_addresses_network_address_idx
ON tracked_addresses(network, normalized_address);
