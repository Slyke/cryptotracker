import { describe, expect, it, vi } from 'vitest';
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

  it('omits only leading zero-value points from the portfolio series', async () => {
    const runtime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime });
    try {
      await bootstrapApplicationData({ db, runtime });
      const bucketMs = 1_800_000;
      const firstTimestampMs = Math.floor((Date.now() - 4 * bucketMs) / bucketMs) * bucketMs;
      const values = ['0', '0', '100', '0'];

      for (const [index, value] of values.entries()) {
        const timestampMs = firstTimestampMs + index * bucketMs;
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency,
              bucket_start_ms, granularity_seconds, data_kind,
              close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', 'bitcoin', 'CAD', ?, 300, 'native', ?, ?)
          `,
          parameters: [`price-${index}`, timestampMs, value, timestampMs]
        });
        await db.run({
          sql: `
            INSERT INTO portfolio_snapshots(
              id, captured_at_ms, primary_currency, values_json, quantities_json,
              priced_coverage_percent, incomplete_balance_count, provenance_json
            ) VALUES (?, ?, 'CAD', ?, '{"bitcoin":"1"}', '100', 0, '{}')
          `,
          parameters: [
            `portfolio-${index}`,
            timestampMs,
            JSON.stringify({ CAD: value })
          ]
        });
      }

      const result = await new PortfolioService(db, runtime).series({
        fromMs: firstTimestampMs,
        toMs: firstTimestampMs + 3 * bucketMs,
        quoteCurrencies: ['CAD'],
        granularitySeconds: 1_800
      });

      expect(result.series[0]?.points.map((point) => ({
        timestampMs: point.timestampMs,
        value: point.value
      }))).toEqual([
        { timestampMs: firstTimestampMs + 2 * bucketMs, value: '100' },
        { timestampMs: firstTimestampMs + 3 * bucketMs, value: '0' }
      ]);
      expect(await db.one<{ count: number }>({
        sql: 'SELECT COUNT(*) AS count FROM portfolio_snapshots'
      })).toEqual({ count: 4 });
    } finally {
      await db.close();
    }
  });

  it('adds the shared current valuation when a live range is newer than its last snapshot', async () => {
    const now = Date.UTC(2026, 7, 5, 16, 44);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const runtime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime });
    try {
      await bootstrapApplicationData({ db, runtime });
      const bucketMs = 1_800_000;
      const bucketStartMs = Math.floor(now / bucketMs) * bucketMs;
      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label,
            enabled, created_at_ms, updated_at_ms
          ) VALUES ('address-live', 'bitcoin', 'fixture-live', 'fixture-live', 'Live address', 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_asset_selections(
            id, address_id, canonical_asset_id, contract_or_mint,
            enabled, created_at_ms, updated_at_ms
          ) VALUES ('selection-live', 'address-live', 'bitcoin', NULL, 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, provider_boundary_json,
            warnings_json, last_success_at_ms, updated_at_ms
          ) VALUES ('address-live', 'complete', '{}', '{}', '[]', ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_balance_points(
            id, address_id, canonical_asset_id, bucket_start_ms,
            granularity_seconds, quantity, price_coverage
          ) VALUES ('address-point-live', 'address-live', 'bitcoin', ?, 0, '1', 'balance_observed')
        `,
        parameters: [now]
      });
      await db.run({
        sql: `
          INSERT INTO portfolio_snapshots(
            id, captured_at_ms, primary_currency, values_json, quantities_json,
            priced_coverage_percent, incomplete_balance_count, provenance_json
          ) VALUES ('portfolio-live', ?, 'CAD', '{"CAD":"100"}', '{"bitcoin":"1"}', '100', 0, '{}')
        `,
        parameters: [bucketStartMs]
      });
      for (const [id, timestampMs, value] of [
        ['price-snapshot', bucketStartMs, '100'],
        ['price-current', bucketStartMs + 300_000, '110']
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency,
              bucket_start_ms, granularity_seconds, data_kind,
              close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', 'bitcoin', 'CAD', ?, 300, 'native', ?, ?)
          `,
          parameters: [id, timestampMs, value, timestampMs]
        });
      }

      const service = new PortfolioService(db, runtime);
      await expect(service.current({ quoteCurrencies: ['CAD'] })).resolves.toMatchObject({
        capturedAtMs: now,
        values: { CAD: '110' },
        quantities: { bitcoin: '1' }
      });
      const result = await service.series({
        fromMs: bucketStartMs,
        toMs: now,
        quoteCurrencies: ['CAD'],
        granularitySeconds: 1_800
      });
      expect(result.series[0]?.points.map((point) => ({
        timestampMs: point.timestampMs,
        value: point.value,
        cad: point.quotes.CAD
      }))).toEqual([
        { timestampMs: bucketStartMs, value: '100', cad: '100' },
        { timestampMs: now, value: '110', cad: '110' }
      ]);
    } finally {
      nowSpy.mockRestore();
      await db.close();
    }
  });
});
