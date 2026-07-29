import { describe, expect, it } from 'vitest';
import { RetentionService } from '../src/services/retention.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('historical point retention', () => {
  it('prunes old points and snapshots while preserving reconstructive activity', async () => {
    const { db } = await openMigratedTestDatabase();
    const now = Date.now();
    const old = now - 10 * 24 * 60 * 60_000;
    const recent = now - 60 * 60_000;
    try {
      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label, enabled, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `,
        parameters: ['address-1', 'bitcoin', 'bc1fixture', 'bc1fixture', 'Fixture', now, now]
      });
      for (const [id, timestamp] of [['old', old], ['recent', recent]] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
              granularity_seconds, data_kind, close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', 'bitcoin', 'CAD', ?, 300, 'native', '100', ?)
          `,
          parameters: [`market-${id}`, timestamp, timestamp]
        });
        await db.run({
          sql: `
            INSERT INTO address_balance_points(
              id, address_id, canonical_asset_id, bucket_start_ms,
              granularity_seconds, quantity, price_coverage
            ) VALUES (?, 'address-1', 'bitcoin', ?, 300, '1', 'priced')
          `,
          parameters: [`address-point-${id}`, timestamp]
        });
        await db.run({
          sql: `
            INSERT INTO kraken_snapshots(
              id, captured_at_ms, total_value_currency, total_value, price_coverage
            ) VALUES (?, ?, 'CAD', '100', '100')
          `,
          parameters: [`snapshot-${id}`, timestamp]
        });
      }
      await db.run({
        sql: `
          INSERT INTO kraken_snapshot_balances(
            snapshot_id, asset_raw, canonical_asset_id, category, quantity, priced
          ) VALUES ('snapshot-old', 'XXBT', 'bitcoin', 'spot', '1', 1)
        `
      });
      for (const [id, observedAtMs, lastSeenAtMs] of [
        ['observation-old', old, old],
        ['observation-current-interval', old, recent],
        ['observation-recent', recent, recent]
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO kraken_account_observations(
              id, endpoint, entity_id, observed_at_ms, last_seen_at_ms,
              present, payload_hash, raw_json, raw_bytes
            ) VALUES (?, 'trade-balance', ?, ?, ?, 1, ?, '{}', 2)
          `,
          parameters: [id, id, observedAtMs, lastSeenAtMs, id]
        });
      }
      await db.run({
        sql: `
          INSERT INTO chain_transactions(
            id, address_id, network, transaction_id, occurred_at_ms, confirmation_state
          ) VALUES ('chain-old', 'address-1', 'bitcoin', 'tx-old', ?, 'confirmed')
        `,
        parameters: [old]
      });
      await db.run({
        sql: `
          INSERT INTO address_balance_events(
            id, address_id, transaction_id, canonical_asset_id, occurred_at_ms,
            ordering_key, quantity_delta, event_type, finalized
          ) VALUES ('event-old', 'address-1', 'tx-old', 'bitcoin', ?, '1', '1', 'receive', 1)
        `,
        parameters: [old]
      });
      await db.run({
        sql: `
          INSERT INTO kraken_trades(
            id, kraken_id, pair_raw, side, occurred_at_ms, quantity, price
          ) VALUES ('trade-old', 'trade-old', 'XXBTCAD', 'buy', ?, '1', '100')
        `,
        parameters: [old]
      });
      await db.run({
        sql: `
          INSERT INTO calculation_runs(
            id, method, currency, source_hash, status, started_at_ms
          ) VALUES ('calculation-old', 'acb', 'CAD', 'hash', 'completed', ?)
        `,
        parameters: [old]
      });
      await db.run({
        sql: `
          INSERT INTO cost_basis_lots(
            id, calculation_run_id, method, canonical_asset_id, acquired_at_ms,
            original_quantity, remaining_quantity, basis_currency, basis_amount,
            basis_known, source_type, source_id
          ) VALUES (
            'lot-old', 'calculation-old', 'acb', 'bitcoin', ?,
            '1', '1', 'CAD', '100', 1, 'trade', 'trade-old'
          )
        `,
        parameters: [old]
      });

      const result = await new RetentionService(db).apply({ retentionDays: 7 });

      expect(result.deleted).toEqual({
        marketPoints: 1,
        addressBalancePoints: 1,
        krakenSnapshots: 1,
        krakenAccountObservations: 1,
        portfolioSnapshots: 0
      });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM market_points' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM address_balance_points' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM kraken_snapshots' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM kraken_snapshot_balances' })).toEqual({ count: 0 });
      expect(await db.query<{ id: string }>({
        sql: 'SELECT id FROM kraken_account_observations ORDER BY id'
      })).toEqual([
        { id: 'observation-current-interval' },
        { id: 'observation-recent' }
      ]);
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM chain_transactions' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM address_balance_events' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM kraken_trades' })).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM cost_basis_lots' })).toEqual({ count: 1 });
    } finally {
      await db.close();
    }
  });

  it('does not prune anything when retention is Forever', async () => {
    const { db } = await openMigratedTestDatabase();
    try {
      await db.run({
        sql: `
          INSERT INTO market_points(
            id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
            granularity_seconds, data_kind, close_value, retrieved_at_ms
          ) VALUES ('forever-point', 'fixture', 'bitcoin', 'CAD', 1, 300, 'native', '100', 1)
        `
      });
      const result = await new RetentionService(db).apply({ retentionDays: null });
      expect(result.cutoff).toBeNull();
      expect(result.deleted).toEqual({
        marketPoints: 0,
        addressBalancePoints: 0,
        krakenSnapshots: 0,
        krakenAccountObservations: 0,
        portfolioSnapshots: 0
      });
      expect(await db.one<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM market_points' })).toEqual({ count: 1 });
    } finally {
      await db.close();
    }
  });

  it('prunes only failed jobs older than the selected failed-job window', async () => {
    const { db } = await openMigratedTestDatabase();
    const now = Date.now();
    const old = now - 8 * 24 * 60 * 60_000;
    const recent = now - 60 * 60_000;
    try {
      for (const [id, status, timestamp] of [
        ['old-failed', 'failed', old],
        ['recent-failed', 'failed', recent],
        ['old-completed', 'completed', old]
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO jobs(
              id, job_type, resource_key, idempotency_key, priority,
              status, created_at_ms, updated_at_ms, completed_at_ms
            ) VALUES (?, 'fixture.sync', ?, ?, 40, ?, ?, ?, ?)
          `,
          parameters: [id, id, `key-${id}`, status, timestamp, timestamp, timestamp]
        });
      }

      const result = await new RetentionService(db).applyFailedJobs({
        retentionHours: 7 * 24
      });

      expect(result.deleted).toBe(1);
      expect(await db.query<{ id: string }>({
        sql: 'SELECT id FROM jobs ORDER BY id'
      })).toEqual([
        { id: 'old-completed' },
        { id: 'recent-failed' }
      ]);
    } finally {
      await db.close();
    }
  });
});
