ALTER TABLE tracked_addresses
DROP CONSTRAINT IF EXISTS tracked_addresses_network_normalized_address_key;

CREATE INDEX IF NOT EXISTS tracked_addresses_network_address_idx
ON tracked_addresses(network, normalized_address);
