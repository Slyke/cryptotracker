import { describe, expect, it } from 'vitest';
import { bootstrapApplicationData } from '../src/services/bootstrap.js';
import { PortfolioService } from '../src/services/portfolio.js';
import { createTestRuntime, openMigratedTestDatabase } from './helpers.js';

describe('combined portfolio snapshots', () => {
  it('starts at locally observed balances and combines address and Kraken quantities exactly', async () => {
    const runtime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime });
    try {
      await bootstrapApplicationData({ db, runtime });
      const now = Date.now();
      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label,
            enabled, created_at_ms, updated_at_ms
          ) VALUES ('address-1', 'bitcoin', 'fixture', 'fixture', 'Fixture address', 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_asset_selections(
            id, address_id, canonical_asset_id, contract_or_mint,
            enabled, created_at_ms, updated_at_ms
          ) VALUES ('selection-1', 'address-1', 'bitcoin', NULL, 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, provider_boundary_json,
            warnings_json, last_success_at_ms, updated_at_ms
          ) VALUES ('address-1', 'partial', '{}', '{}', '[]', ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_balance_points(
            id, address_id, canonical_asset_id, bucket_start_ms,
            granularity_seconds, quantity, price_coverage
          ) VALUES ('address-point-1', 'address-1', 'bitcoin', ?, 0, '2', 'balance_observed')
        `,
        parameters: [now]
      });
      await db.run({
        sql: `
          INSERT INTO kraken_snapshots(
            id, captured_at_ms, total_value_currency, total_value,
            price_coverage, provenance_json
          ) VALUES ('kraken-snapshot-1', ?, 'CAD', '30', '100', '{}')
        `,
        parameters: [now]
      });
      await db.run({
        sql: `
          INSERT INTO kraken_snapshot_balances(
            snapshot_id, asset_raw, canonical_asset_id, category,
            quantity, value_currency, value_amount, priced
          ) VALUES ('kraken-snapshot-1', 'XETH', 'ethereum', 'spot', '3', 'CAD', '30', 1)
        `
      });
      for (const [assetId, price] of [['bitcoin', '100'], ['ethereum', '10']] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency,
              bucket_start_ms, granularity_seconds, data_kind,
              close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', ?, 'CAD', ?, 300, 'native', ?, ?)
          `,
          parameters: [`price-${assetId}`, assetId, now, price, now]
        });
      }

      const service = new PortfolioService(db, runtime);
      await service.capture();
      const result = await service.series({
        fromMs: 0,
        toMs: now + 1_000,
        quoteCurrencies: ['CAD']
      });
      expect(result.backfilled).toBe(false);
      expect(result.series[0]?.points).toHaveLength(1);
      expect(result.series[0]?.points[0]).toMatchObject({
        value: '230',
        quotes: {
          CAD: '230'
        },
        quantities: {
          bitcoin: '2',
          ethereum: '3'
        }
      });
      expect(await db.one<{ count: number }>({
        sql: 'SELECT COUNT(*) AS count FROM portfolio_snapshots'
      })).toEqual({ count: 1 });

      await service.series({
        fromMs: 0,
        toMs: 1_000,
        quoteCurrencies: ['CAD']
      });
      expect(await db.one<{ count: number }>({
        sql: 'SELECT COUNT(*) AS count FROM portfolio_snapshots'
      })).toEqual({ count: 1 });
    } finally {
      await db.close();
    }
  });
});
