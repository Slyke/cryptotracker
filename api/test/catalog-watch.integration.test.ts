import { describe, expect, it } from 'vitest';
import type { JobQueue } from '../src/jobs/queue.js';
import { DiagnosticsService } from '../src/services/diagnostics.js';
import { MarketService } from '../src/services/market.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('ranked catalog watch actions', () => {
  it('enables exactly the first 100 fetched catalog rows even when one rank is missing', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    try {
      const now = Date.now();
      for (let index = 1; index <= 100; index += 1) {
        await db.run({
          sql: `
            INSERT INTO asset_catalog(
              canonical_id, symbol, name, market_cap_rank, source, updated_at_ms
            ) VALUES (?, ?, ?, ?, 'fixture', ?)
          `,
          parameters: [
            `asset-${index}`,
            `A${index}`,
            `Asset ${index}`,
            index === 100 ? null : index,
            now
          ]
        });
      }
      const market = new MarketService(
        db,
        runtime,
        new Map(),
        null as unknown as JobQueue
      );

      const first = await market.addTopAssets({ limit: 100 });
      const second = await market.addTopAssets({ limit: 100 });

      expect(first.addedOrEnabled).toBe(100);
      expect(second.addedOrEnabled).toBe(100);
      expect(await market.listWatchlist()).toHaveLength(100);
    } finally {
      await db.close();
    }
  });

  it('cancels queued market work and rejects new backfills when an asset is disabled', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    try {
      const now = Date.now();
      await db.run({
        sql: `
          INSERT INTO asset_catalog(
            canonical_id, symbol, name, market_cap_rank, source, updated_at_ms
          ) VALUES ('ethereum', 'ETH', 'Ethereum', 2, 'fixture', ?)
        `,
        parameters: [now]
      });
      await db.run({
        sql: `
          INSERT INTO asset_provider_mappings(
            id, canonical_asset_id, provider, provider_asset_id,
            provider_symbol, pair_id, metadata_json, updated_at_ms
          ) VALUES ('map-eth', 'ethereum', 'coingecko', 'ethereum', 'eth', 'ethereum', '{}', ?)
        `,
        parameters: [now]
      });
      const market = new MarketService(
        db,
        runtime,
        new Map(),
        null as unknown as JobQueue
      );
      const asset = await market.addAsset({ canonicalId: 'ethereum' });
      await db.run({
        sql: `
          INSERT INTO jobs(
            id, job_type, resource_key, idempotency_key, priority, status,
            payload_json, created_at_ms, updated_at_ms
          ) VALUES (?, 'market.sync', ?, ?, 40, 'queued', ?, ?, ?)
        `,
        parameters: [
          'job-eth',
          'coingecko:ethereum:CAD:86400',
          'market:ethereum:fixture',
          JSON.stringify({
            provider: 'coingecko',
            canonicalAssetId: 'ethereum',
            quoteCurrency: 'CAD'
          }),
          now,
          now
        ]
      });

      await market.patchAsset({ id: asset.id, enabled: false });
      const bucketStartMs = Math.floor(now / 86_400_000) * 86_400_000;
      await db.run({
        sql: `
          INSERT INTO market_points(
            id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
            granularity_seconds, data_kind, close_value, retrieved_at_ms
          ) VALUES ('disabled-eth-history', 'coingecko', 'ethereum', 'CAD', ?, 86400, 'native', '5000', ?)
        `,
        parameters: [bucketStartMs, now]
      });
      const job = await db.one<{ status: string }>({
        sql: 'SELECT status FROM jobs WHERE id = ?',
        parameters: ['job-eth']
      });
      const backfill = await market.queueBackfill({
        provider: 'coingecko',
        canonicalAssetId: 'ethereum',
        quoteCurrency: 'CAD',
        fromMs: now - 86_400_000,
        toMs: now,
        granularitySeconds: 86_400
      });

      const progress = await new DiagnosticsService(
        db, runtime, market, null as never, null as never
      ).syncProgress();
      const savedDashboardSeries = await market.getSeries({
        assetIds: ['ethereum'],
        quoteCurrency: 'CAD',
        source: 'combined',
        fromMs: bucketStartMs,
        toMs: bucketStartMs + 86_400_000,
        granularity: 86_400,
        chartMode: 'line'
      });

      expect(job?.status).toBe('cancelled');
      expect(backfill).toMatchObject({ skipped: true, canonicalAssetId: 'ethereum' });
      expect(progress.market).toEqual([]);
      expect(progress.jobs.some((entry) => entry.id === 'job-eth')).toBe(false);
      expect(savedDashboardSeries.series).toEqual([
        expect.objectContaining({
          id: 'ethereum',
          label: 'ETH · Ethereum',
          points: [expect.objectContaining({ value: '5000' })]
        })
      ]);
    } finally {
      await db.close();
    }
  });
});
