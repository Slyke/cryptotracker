import { Decimal } from 'decimal.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { combineCandles, combinePriceObservations, type CandleObservation, type PriceObservation } from '../domain/market.js';
import {
  boundedOverviewGranularity,
  resolveAutoGranularity
} from '../domain/graphs.js';
import { AppError } from '../errors.js';
import { lifecycleAndDisputeEvents } from './event-markers.js';
import type { JobQueue } from '../jobs/queue.js';
import { marketProviderInternals, type MarketPair, type MarketProviderAdapter } from '../providers/market.js';
import { createId } from '../utils/ids.js';
import { ReadThroughCache } from '../utils/read-through-cache.js';
import { getBuiltInCatalog } from './bootstrap.js';
import { aggregateCachedMarketRows, deriveQuoteFallbackRows } from './market-aggregation.js';

interface AssetRow {
  id: string;
  canonical_id: string;
  symbol: string;
  name: string;
  network: string | null;
  contract_or_mint: string | null;
  enabled: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

interface MappingRow {
  canonical_asset_id: string;
  provider: string;
  provider_asset_id: string;
  provider_symbol: string;
  pair_id: string;
}

interface CatalogRow {
  canonical_id: string;
  symbol: string;
  name: string;
  network: string | null;
  contract_or_mint: string | null;
  market_cap_rank: number | string | null;
  source: string;
  metadata_json: string;
  updated_at_ms: number | string;
}

interface MarketPointRow {
  provider: string;
  canonical_asset_id: string;
  quote_currency: string;
  bucket_start_ms: number | string;
  granularity_seconds: number | string;
  data_kind: 'native' | 'derived';
  open_value: string | null;
  high_value: string | null;
  low_value: string | null;
  close_value: string;
  volume_value: string | null;
  sample_count: number | string;
  finalized: number | string;
  retrieved_at_ms: number | string;
  provenance_json: string;
}

const MAX_MARKET_BUCKETS_PER_SERIES = 20_000;
const MAX_MARKET_BUCKETS_PER_RESPONSE = 250_000;

export const boundedMarketOverviewGranularity = ({
  requestedGranularity,
  fromMs,
  toMs,
  assetCount
}: {
  requestedGranularity: number;
  fromMs: number;
  toMs: number;
  assetCount: number;
}) => {
  return boundedOverviewGranularity({
    requestedGranularity,
    fromMs,
    toMs,
    seriesCount: assetCount
  });
};

const asAsset = (row: AssetRow) => ({
  id: row.id,
  canonicalId: row.canonical_id,
  symbol: row.symbol,
  name: row.name,
  network: row.network,
  contractOrMint: row.contract_or_mint,
  enabled: Boolean(Number(row.enabled)),
  createdAt: new Date(Number(row.created_at_ms)).toISOString(),
  updatedAt: new Date(Number(row.updated_at_ms)).toISOString()
});

export class MarketService {
  private readonly seriesRowsCache = new ReadThroughCache({
    ttlMs: 5_000,
    maxEntries: 32,
    maxSize: 64 * 1_024 * 1_024,
    sizeOf: (value) => Array.isArray(value) ? value.length * 512 : 0
  });
  private readonly seriesMetadataCache = new ReadThroughCache({
    ttlMs: 5_000,
    maxEntries: 64,
    maxSize: 8 * 1_024 * 1_024,
    sizeOf: (value) => Array.isArray(value) ? value.length * 256 : 0
  });

  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly providers: Map<string, MarketProviderAdapter>,
    private readonly jobs: JobQueue
  ) {}

  async listCatalog({ query = '', limit = 100 }: { query?: string; limit?: number } = {}) {
    const normalized = query.trim().toLowerCase();
    const pattern = `%${normalized}%`;
    const rows = await this.db.query<CatalogRow>({
      sql: `
        SELECT * FROM asset_catalog
        WHERE ? = ''
          OR LOWER(canonical_id) LIKE ?
          OR LOWER(symbol) LIKE ?
          OR LOWER(name) LIKE ?
        ORDER BY
          CASE WHEN market_cap_rank IS NULL THEN 1 ELSE 0 END,
          market_cap_rank,
          symbol,
          canonical_id
        LIMIT ?
      `,
      parameters: [normalized, pattern, pattern, pattern, Math.min(500, Math.max(1, limit))]
    });
    if (rows.length === 0 && normalized === '') return getBuiltInCatalog();
    return rows.map((row) => ({
      canonicalId: row.canonical_id,
      symbol: row.symbol,
      name: row.name,
      network: row.network,
      contractOrMint: row.contract_or_mint,
      marketCapRank: row.market_cap_rank === null ? null : Number(row.market_cap_rank),
      source: row.source,
      ambiguousSymbol: false,
      updatedAt: new Date(Number(row.updated_at_ms)).toISOString()
    }));
  }

  async refreshCatalog({ limit = 100 }: { limit?: number } = {}) {
    const provider = this.providers.get('coingecko');
    if (!provider?.fetchCatalog) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'CoinGecko catalog discovery is disabled.',
        status: 404
      });
    }
    const assets = await provider.fetchCatalog({
      quoteCurrency: this.runtime.config.ui.defaultPrimaryCurrency,
      limit: Math.min(100, Math.max(1, limit))
    });
    const now = Date.now();
    await this.db.transaction({
      task: async (executor) => {
        for (const asset of assets) {
          await executor.run({
            sql: `
              INSERT INTO asset_catalog(
                canonical_id, symbol, name, network, contract_or_mint,
                market_cap_rank, source, metadata_json, updated_at_ms
              ) VALUES (?, ?, ?, NULL, NULL, ?, 'coingecko', ?, ?)
              ON CONFLICT(canonical_id) DO UPDATE SET
                symbol = excluded.symbol,
                name = excluded.name,
                market_cap_rank = excluded.market_cap_rank,
                source = excluded.source,
                metadata_json = excluded.metadata_json,
                updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [
              asset.canonicalId,
              asset.symbol,
              asset.name,
              asset.marketCapRank,
              JSON.stringify(asset.metadata),
              now
            ]
          });
          await executor.run({
            sql: `
              INSERT INTO asset_provider_mappings(
                id, canonical_asset_id, provider, provider_asset_id,
                provider_symbol, pair_id, metadata_json, updated_at_ms
              ) VALUES (?, ?, 'coingecko', ?, ?, ?, ?, ?)
              ON CONFLICT(canonical_asset_id, provider, provider_asset_id, pair_id)
              DO UPDATE SET
                provider_symbol = excluded.provider_symbol,
                metadata_json = excluded.metadata_json,
                updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [
              createId({ prefix: 'map' }),
              asset.canonicalId,
              asset.providerAssetId,
              asset.providerSymbol,
              asset.providerAssetId,
              JSON.stringify(asset.metadata),
              now
            ]
          });
        }
      }
    });
    return { assets: assets.length, refreshedAt: new Date(now).toISOString() };
  }

  queueCatalogRefresh() {
    const day = new Date().toISOString().slice(0, 10);
    return this.jobs.enqueue({
      jobType: 'catalog.refresh',
      resourceKey: 'catalog:coingecko:top100',
      idempotencyKey: `catalog:coingecko:top100:${day}`,
      priority: 15,
      payload: { provider: 'coingecko', limit: 100 }
    });
  }

  async listWatchlist() {
    const rows = await this.db.query<AssetRow>({
      sql: 'SELECT * FROM watched_assets ORDER BY enabled DESC, symbol ASC, canonical_id ASC'
    });
    return rows.map(asAsset);
  }

  async isAssetEnabled({ canonicalAssetId }: { canonicalAssetId: string }) {
    const row = await this.db.one<{ enabled: number | string | boolean }>({
      sql: 'SELECT enabled FROM watched_assets WHERE canonical_id = ?',
      parameters: [canonicalAssetId]
    });
    return row !== null && Boolean(Number(row.enabled));
  }

  private async cancelMarketSyncForAsset({ canonicalAssetId }: { canonicalAssetId: string }) {
    return this.db.run({
      sql: `
        UPDATE jobs
        SET status = 'cancelled', completed_at_ms = ?, updated_at_ms = ?, locked_at_ms = NULL, locked_by = NULL
        WHERE job_type = 'market.sync' AND status IN ('queued', 'retry')
          AND resource_key LIKE ?
      `,
      parameters: [Date.now(), Date.now(), `%:${canonicalAssetId}:%`]
    });
  }

  async addAsset({ canonicalId }: { canonicalId: string }) {
    const catalogAsset = await this.db.one<CatalogRow>({
      sql: 'SELECT * FROM asset_catalog WHERE canonical_id = ?',
      parameters: [canonicalId]
    });
    if (!catalogAsset) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: 'Unknown or ambiguous canonical asset. Select a catalog identity.',
        status: 400
      });
    }
    const now = Date.now();
    await this.db.run({
      sql: `
        INSERT INTO watched_assets(
          id, canonical_id, symbol, name, network, contract_or_mint, enabled, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(canonical_id)
        DO UPDATE SET enabled = 1, updated_at_ms = excluded.updated_at_ms
      `,
      parameters: [
        createId({ prefix: 'asset' }),
        catalogAsset.canonical_id,
        catalogAsset.symbol,
        catalogAsset.name,
        catalogAsset.network,
        catalogAsset.contract_or_mint,
        now,
        now
      ]
    });
    return this.db.one<AssetRow>({
      sql: 'SELECT * FROM watched_assets WHERE canonical_id = ?',
      parameters: [canonicalId]
    }).then((row) => asAsset(row!));
  }

  async addTopAssets({ limit }: { limit: 10 | 25 | 50 | 100 }) {
    const assets = await this.db.query<CatalogRow>({
      sql: `
        SELECT * FROM asset_catalog
        ORDER BY CASE WHEN market_cap_rank IS NULL THEN 1 ELSE 0 END, market_cap_rank, canonical_id
        LIMIT ?
      `,
      parameters: [limit]
    });
    const now = Date.now();
    await this.db.transaction({
      task: async (executor) => {
        for (const asset of assets) {
          await executor.run({
            sql: `
              INSERT INTO watched_assets(
                id, canonical_id, symbol, name, network, contract_or_mint,
                enabled, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(canonical_id)
              DO UPDATE SET
                symbol = excluded.symbol,
                name = excluded.name,
                enabled = 1,
                updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [
              createId({ prefix: 'asset' }),
              asset.canonical_id,
              asset.symbol,
              asset.name,
              asset.network,
              asset.contract_or_mint,
              now,
              now
            ]
          });
        }
      }
    });
    return { requested: limit, addedOrEnabled: assets.length, assets: await this.listWatchlist() };
  }

  async providersForAsset({ canonicalAssetId }: { canonicalAssetId: string }) {
    const mappings = await this.db.query<{ provider: string }>({
      sql: 'SELECT DISTINCT provider FROM asset_provider_mappings WHERE canonical_asset_id = ? ORDER BY provider',
      parameters: [canonicalAssetId]
    });
    return mappings.map((row) => row.provider).filter((provider) => this.providers.has(provider));
  }

  async patchAsset({ id, enabled }: { id: string; enabled: boolean }) {
    const result = await this.db.run({
      sql: 'UPDATE watched_assets SET enabled = ?, updated_at_ms = ? WHERE id = ?',
      parameters: [enabled ? 1 : 0, Date.now(), id]
    });
    if (result.changes === 0) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Watched asset was not found.',
        status: 404
      });
    }
    if (!enabled) {
      const row = await this.db.one<AssetRow>({
        sql: 'SELECT * FROM watched_assets WHERE id = ?',
        parameters: [id]
      });
      if (row) await this.cancelMarketSyncForAsset({ canonicalAssetId: row.canonical_id });
    }
    const row = await this.db.one<AssetRow>({
      sql: 'SELECT * FROM watched_assets WHERE id = ?',
      parameters: [id]
    });
    return asAsset(row!);
  }

  async removeAsset({ id }: { id: string }) {
    const existing = await this.db.one<AssetRow>({
      sql: 'SELECT * FROM watched_assets WHERE id = ?',
      parameters: [id]
    });
    if (!existing) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Watched asset was not found.',
        status: 404
      });
    }
    const result = await this.db.run({
      sql: 'DELETE FROM watched_assets WHERE id = ?',
      parameters: [id]
    });
    if (result.changes > 0) await this.cancelMarketSyncForAsset({ canonicalAssetId: existing.canonical_id });
  }

  async getPair({
    canonicalAssetId,
    provider,
    quoteCurrency
  }: {
    canonicalAssetId: string;
    provider: string;
    quoteCurrency: string;
  }): Promise<MarketPair> {
    const row = await this.db.one<MappingRow>({
      sql: `
        SELECT canonical_asset_id, provider, provider_asset_id, provider_symbol, pair_id
        FROM asset_provider_mappings
        WHERE canonical_asset_id = ? AND provider = ?
        ORDER BY
          CASE WHEN provider = 'coinbase' AND pair_id LIKE '%-USD' THEN 0 ELSE 1 END,
          updated_at_ms DESC
        LIMIT 1
      `,
      parameters: [canonicalAssetId, provider]
    });
    if (!row) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: `${provider} has no mapped pair for ${canonicalAssetId}.`,
        status: 404
      });
    }
    const requestedQuoteCurrency = quoteCurrency.toUpperCase();
    const providerQuoteCurrency = provider === 'coinbase'
      ? row.pair_id.split('-').at(-1) ?? 'USD'
      : requestedQuoteCurrency;
    const pairId = provider === 'coinbase'
      ? row.pair_id
      : requestedQuoteCurrency === 'CAD'
        ? row.pair_id
        : provider === 'kraken'
          ? `${row.provider_symbol}${requestedQuoteCurrency}`
          : row.pair_id;
    return {
      canonicalAssetId,
      quoteCurrency: providerQuoteCurrency,
      providerAssetId: row.provider_asset_id,
      providerSymbol: row.provider_symbol,
      pairId
    };
  }

  private planSynchronizationWindows({
    provider,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    provider: string;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }) {
    if (toMs < fromMs) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: 'Market synchronization end must not precede its start.',
        status: 400
      });
    }

    return provider === 'coinbase'
      ? marketProviderInternals.coinbaseRequestWindows({
          fromMs,
          toMs,
          granularitySeconds
        })
      : provider === 'coingecko'
        ? marketProviderInternals.coingeckoRequestWindows({
            fromMs,
            toMs,
            granularitySeconds
          })
      : [{ fromMs, toMs }];
  }

  private async synchronizeWindow({
    provider,
    canonicalAssetId,
    quoteCurrency,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    provider: string;
    canonicalAssetId: string;
    quoteCurrency: string;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }) {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: `Market provider ${provider} is disabled or unknown.`,
        status: 404
      });
    }
    const pair = await this.getPair({
      canonicalAssetId,
      provider,
      quoteCurrency
    });
    const candles = await adapter.fetchCandles({
      pair,
      fromMs,
      toMs,
      granularitySeconds
    });
    const now = Date.now();
    await this.db.transaction({
      task: async (executor) => {
        for (const candle of candles) {
          await executor.run({
            sql: `
              INSERT INTO market_points(
                id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
                granularity_seconds, data_kind, open_value, high_value, low_value,
                close_value, volume_value, sample_count, finalized, retrieved_at_ms,
                provenance_json, disputed, spread_value, contributing_values_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '{}')
              ON CONFLICT(provider, canonical_asset_id, quote_currency, bucket_start_ms, granularity_seconds, data_kind)
              DO UPDATE SET
                open_value = excluded.open_value,
                high_value = excluded.high_value,
                low_value = excluded.low_value,
                close_value = excluded.close_value,
                volume_value = excluded.volume_value,
                sample_count = excluded.sample_count,
                finalized = excluded.finalized,
                retrieved_at_ms = excluded.retrieved_at_ms,
                provenance_json = excluded.provenance_json
            `,
            parameters: [
              createId({ prefix: 'mkt' }),
              provider,
              canonicalAssetId,
              pair.quoteCurrency.toUpperCase(),
              candle.bucketStartMs,
              candle.granularitySeconds,
              candle.dataKind,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.volume,
              Number(candle.provenance.nativePointSamples ?? candle.provenance.tradeCount ?? 1),
              candle.finalized ? 1 : 0,
              now,
              JSON.stringify(candle.provenance)
            ]
          });
        }
        await executor.run({
          sql: `
            INSERT INTO market_sync_cursors(
              provider, canonical_asset_id, quote_currency, granularity_seconds,
              cursor_json, oldest_at_ms, newest_at_ms, completeness, last_success_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, '{}', ?, ?, 'partial', ?, ?)
            ON CONFLICT(provider, canonical_asset_id, quote_currency, granularity_seconds)
            DO UPDATE SET
              oldest_at_ms = CASE
                WHEN market_sync_cursors.oldest_at_ms IS NULL OR excluded.oldest_at_ms < market_sync_cursors.oldest_at_ms
                THEN excluded.oldest_at_ms ELSE market_sync_cursors.oldest_at_ms END,
              newest_at_ms = CASE
                WHEN market_sync_cursors.newest_at_ms IS NULL OR excluded.newest_at_ms > market_sync_cursors.newest_at_ms
                THEN excluded.newest_at_ms ELSE market_sync_cursors.newest_at_ms END,
              last_success_at_ms = excluded.last_success_at_ms,
              updated_at_ms = excluded.updated_at_ms
          `,
          parameters: [
            provider,
            canonicalAssetId,
            pair.quoteCurrency.toUpperCase(),
            candles[0]?.granularitySeconds ?? granularitySeconds,
            candles[0]?.bucketStartMs ?? null,
            candles.at(-1)?.bucketStartMs ?? null,
            now,
            now
          ]
        });
      }
    });
    return { insertedOrUpdated: candles.length };
  }

  async synchronizeRange({
    provider,
    canonicalAssetId,
    quoteCurrency,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    provider: string;
    canonicalAssetId: string;
    quoteCurrency: string;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }) {
    const windows = this.planSynchronizationWindows({
      provider,
      fromMs,
      toMs,
      granularitySeconds
    });
    let insertedOrUpdated = 0;
    for (const window of windows) {
      const result = await this.synchronizeWindow({
        provider,
        canonicalAssetId,
        quoteCurrency,
        granularitySeconds,
        ...window
      });
      insertedOrUpdated += result.insertedOrUpdated;
    }
    return { insertedOrUpdated, windowsProcessed: windows.length };
  }

  async queueBackfill({
    provider,
    canonicalAssetId,
    quoteCurrency,
    fromMs,
    toMs,
    granularitySeconds,
    repair = false
  }: {
    provider: string;
    canonicalAssetId: string;
    quoteCurrency: string;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
    repair?: boolean;
  }) {
    if (!await this.isAssetEnabled({ canonicalAssetId })) {
      return {
        skipped: true,
        provider,
        canonicalAssetId,
        quoteCurrency: quoteCurrency.toUpperCase(),
        reason: `${canonicalAssetId} is disabled in Markets.`,
        supportedProviders: [] as string[]
      };
    }
    const supportedProviders = await this.providersForAsset({ canonicalAssetId });
    if (!supportedProviders.includes(provider)) {
      return {
        skipped: true,
        provider,
        canonicalAssetId,
        quoteCurrency: quoteCurrency.toUpperCase(),
        reason: `${provider} has no catalog mapping for ${canonicalAssetId}.`,
        supportedProviders
      };
    }
    const providerQuoteCurrency = provider === 'coinbase'
      ? 'USD'
      : quoteCurrency.toUpperCase();
    return this.jobs.enqueue({
      jobType: 'market.sync',
      resourceKey: `${provider}:${canonicalAssetId}:${providerQuoteCurrency}:${granularitySeconds}`,
      idempotencyKey: `market:v2:${repair ? 'repair' : 'backfill'}:${provider}:${canonicalAssetId}:${providerQuoteCurrency}:${granularitySeconds}:${fromMs}:${toMs}`,
      priority: repair ? 5 : 40,
      payload: {
        provider,
        canonicalAssetId,
        quoteCurrency: providerQuoteCurrency,
        fromMs,
        toMs,
        granularitySeconds
      }
    });
  }

  async queueBackfillIfNeeded({
    provider,
    canonicalAssetId,
    quoteCurrency,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    provider: string;
    canonicalAssetId: string;
    quoteCurrency: string;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }) {
    const providerQuoteCurrency = provider === 'coinbase'
      ? 'USD'
      : quoteCurrency.toUpperCase();
    const providerGranularitySeconds = provider === 'coinbase'
      ? marketProviderInternals.coinbaseGranularity({ requested: granularitySeconds })
      : provider === 'kraken'
        ? marketProviderInternals.krakenIntervalMinutes({ requested: granularitySeconds }) * 60
        : granularitySeconds;
    const cursor = await this.db.one<{
      oldest_at_ms: number | string | null;
      provider_boundary_reached: number | string;
    }>({
      sql: `
        SELECT
          MIN(oldest_at_ms) AS oldest_at_ms,
          MAX(CASE WHEN completeness = 'complete' THEN 1 ELSE 0 END) AS provider_boundary_reached
        FROM market_sync_cursors
        WHERE provider = ? AND canonical_asset_id = ?
          AND quote_currency = ? AND granularity_seconds IN (?, ?)
      `,
      parameters: [
        provider,
        canonicalAssetId,
        providerQuoteCurrency,
        providerGranularitySeconds,
        granularitySeconds
      ]
    });
    const oldestAtMs = cursor?.oldest_at_ms === null || cursor?.oldest_at_ms === undefined
      ? null
      : Number(cursor.oldest_at_ms);
    if (fromMs === 0 && Boolean(Number(cursor?.provider_boundary_reached ?? 0))) {
      return {
        skipped: true,
        provider,
        canonicalAssetId,
        quoteCurrency: providerQuoteCurrency,
        reason: 'Provider history boundary already reached.'
      };
    }
    const cachedPointCount = provider === 'coingecko' && granularitySeconds === 3_600
      ? await this.db.one<{ count: number | string }>({
          sql: `
            SELECT COUNT(*) AS count
            FROM market_points
            WHERE provider = ? AND canonical_asset_id = ? AND quote_currency = ?
              AND granularity_seconds = ?
              AND bucket_start_ms >= ? AND bucket_start_ms <= ?
          `,
          parameters: [
            provider,
            canonicalAssetId,
            providerQuoteCurrency,
            granularitySeconds,
            fromMs,
            toMs
          ]
        })
      : null;
    const expectedPointCount = Math.max(
      1,
      Math.floor((toMs - fromMs) / (granularitySeconds * 1_000))
    );
    const cadenceLooksSparse = cachedPointCount !== null
      && Number(cachedPointCount.count) < expectedPointCount * 0.5;
    if (
      oldestAtMs !== null
      && oldestAtMs <= fromMs + (granularitySeconds * 1_000)
      && !cadenceLooksSparse
    ) {
      return {
        skipped: true,
        provider,
        canonicalAssetId,
        quoteCurrency: providerQuoteCurrency,
        reason: 'Cached history already reaches the requested start.'
      };
    }
    return this.queueBackfill({
      provider,
      canonicalAssetId,
      quoteCurrency,
      fromMs,
      toMs,
      granularitySeconds
    });
  }

  registerJobs() {
    this.jobs.register({
      jobType: 'catalog.refresh',
      handler: async ({ updateProgress }) => {
        await updateProgress({ current: 0, total: 1, cursor: { provider: 'coingecko' } });
        const result = await this.refreshCatalog({ limit: 100 });
        await updateProgress({ current: 1, total: 1, cursor: result });
      }
    });

    this.jobs.register({
      jobType: 'market.sync',
      handler: async ({ job, updateProgress }) => {
        const payload = JSON.parse(job.payload_json) as {
          provider: string;
          canonicalAssetId: string;
          quoteCurrency: string;
          fromMs: number;
          toMs: number;
          granularitySeconds: number;
        };
        const cancelIfDisabled = async () => {
          if (await this.isAssetEnabled({ canonicalAssetId: payload.canonicalAssetId })) return false;
          await this.db.run({
            sql: `
              UPDATE jobs
              SET status = 'cancelled', completed_at_ms = ?, updated_at_ms = ?, locked_at_ms = NULL, locked_by = NULL
              WHERE id = ? AND status = 'running'
            `,
            parameters: [Date.now(), Date.now(), job.id]
          });
          return true;
        };
        if (await cancelIfDisabled()) return;
        const windows = this.planSynchronizationWindows(payload);
        await updateProgress({
          current: 0,
          total: windows.length,
          cursor: { fromMs: payload.fromMs }
        });
        for (const [index, window] of windows.entries()) {
          if (await cancelIfDisabled()) return;
          await this.synchronizeWindow({ ...payload, ...window });
          await updateProgress({
            current: index + 1,
            total: windows.length,
            cursor: {
              fromMs: payload.fromMs,
              toMs: window.toMs
            }
          });
        }
        if (payload.fromMs === 0) {
          const providerGranularitySeconds = payload.provider === 'coinbase'
            ? marketProviderInternals.coinbaseGranularity({
                requested: payload.granularitySeconds
              })
            : payload.provider === 'kraken'
              ? marketProviderInternals.krakenIntervalMinutes({
                  requested: payload.granularitySeconds
                }) * 60
              : payload.granularitySeconds;
          await this.db.run({
            sql: `
              UPDATE market_sync_cursors
              SET completeness = 'complete', updated_at_ms = ?
              WHERE provider = ? AND canonical_asset_id = ? AND quote_currency = ?
                AND granularity_seconds IN (?, ?)
            `,
            parameters: [
              Date.now(),
              payload.provider,
              payload.canonicalAssetId,
              payload.quoteCurrency.toUpperCase(),
              providerGranularitySeconds,
              payload.granularitySeconds
            ]
          });
        }
      }
    });
  }

  private queryOverviewRows({
    assetIds,
    source,
    overviewGranularity,
    bucketMs,
    rangeStartMs,
    rangeEndMs
  }: {
    assetIds: string[];
    source: 'combined' | 'coingecko' | 'coinbase' | 'kraken';
    overviewGranularity: number;
    bucketMs: number;
    rangeStartMs: number;
    rangeEndMs: number;
  }) {
    const placeholders = assetIds.map(() => '?').join(', ');
    return this.db.query<MarketPointRow>({
      sql: `
        WITH candidates AS (
          SELECT *,
            MAX(CASE WHEN granularity_seconds <= ? THEN granularity_seconds END)
              OVER (
                PARTITION BY provider, canonical_asset_id, quote_currency,
                  CAST(bucket_start_ms / ? AS INTEGER)
              ) AS best_fine_granularity,
            MIN(CASE WHEN granularity_seconds > ? THEN granularity_seconds END)
              OVER (
                PARTITION BY provider, canonical_asset_id, quote_currency,
                  CAST(bucket_start_ms / ? AS INTEGER)
              ) AS best_coarse_granularity
          FROM market_points
          WHERE canonical_asset_id IN (${placeholders})
            AND bucket_start_ms >= ?
            AND bucket_start_ms <= ?
            ${source === 'combined' ? '' : "AND (provider = ? OR provider = 'coingecko')"}
        )
        SELECT
          provider, canonical_asset_id, quote_currency, bucket_start_ms,
          granularity_seconds, data_kind, open_value, high_value, low_value,
          close_value, volume_value, sample_count, finalized, retrieved_at_ms,
          provenance_json
        FROM candidates
        WHERE granularity_seconds = COALESCE(
          best_fine_granularity,
          best_coarse_granularity
        )
        ORDER BY canonical_asset_id, quote_currency, bucket_start_ms, provider, data_kind
      `,
      parameters: [
        overviewGranularity,
        bucketMs,
        overviewGranularity,
        bucketMs,
        ...assetIds,
        rangeStartMs,
        rangeEndMs,
        ...(source === 'combined' ? [] : [source])
      ]
    });
  }

  async getSeries({
    assetIds,
    quoteCurrency,
    source,
    fromMs,
    toMs,
    granularity,
    chartMode
  }: {
    assetIds: string[];
    quoteCurrency: string;
    source: 'combined' | 'coingecko' | 'coinbase' | 'kraken';
    fromMs: number;
    toMs: number;
    granularity: number | 'auto';
    chartMode: 'line' | 'candlestick';
  }) {
    const resolvedGranularity = granularity === 'auto'
      ? resolveAutoGranularity({ fromMs, toMs })
      : granularity;
    const overviewGranularity = boundedMarketOverviewGranularity({
      requestedGranularity: resolvedGranularity,
      fromMs,
      toMs,
      assetCount: assetIds.length
    });
    const bucketMs = overviewGranularity * 1_000;
    const rangeStartMs = Math.floor(fromMs / bucketMs) * bucketMs;
    const rangeEndMs = Math.floor(toMs / bucketMs) * bucketMs;
    const expectedBuckets = Math.ceil(Math.max(0, toMs - fromMs) / bucketMs);
    const expectedTotalBuckets = expectedBuckets * assetIds.length;
    if (
      expectedBuckets > MAX_MARKET_BUCKETS_PER_SERIES
      || expectedTotalBuckets > MAX_MARKET_BUCKETS_PER_RESPONSE
      || assetIds.length > 50
    ) {
      throw new AppError({
        errorKey: 'RANGE_TOO_LARGE',
        reason: 'Requested range and granularity produce too many chart buckets. Zoom in or choose a coarser resolution.',
        status: 400,
        context: { expectedBuckets, expectedTotalBuckets, assetCount: assetIds.length }
      });
    }
    if (assetIds.length === 0) {
      return {
        resolvedGranularity,
        overviewGranularity,
        mixedGranularity: false,
        sourceGranularities: [],
        stale: false,
        partial: false,
        missingIntervals: [],
        events: [],
        series: []
      };
    }
    const placeholders = assetIds.map(() => '?').join(', ');
    const bridgeCurrency = 'USD';
    const quoteCurrencies = [...new Set([quoteCurrency.toUpperCase(), bridgeCurrency])];
    const quotePlaceholders = quoteCurrencies.map(() => '?').join(', ');
    const labelsPromise = this.seriesMetadataCache.get({
      key: 'watchlist-labels',
      load: () => this.listWatchlist()
    });
    const eventsPromise = this.seriesMetadataCache.get({
      key: `events:${JSON.stringify({
        assetIds: [...assetIds].sort(),
        fromSecond: Math.floor(fromMs / 1_000),
        toSecond: Math.floor(toMs / 1_000)
      })}`,
      load: () => lifecycleAndDisputeEvents({
        db: this.db,
        assetIds,
        fromMs,
        toMs
      })
    });
    // Dashboard market charts request the same assets once per tooltip currency.
    // Read every locally stored currency in one scan so those concurrent calls
    // coalesce here instead of repeating the expensive window query for each one.
    const rows = await this.seriesRowsCache.get<MarketPointRow[]>({
      key: JSON.stringify({
        assetIds: [...assetIds].sort(),
        source,
        overviewGranularity,
        bucketMs,
        rangeStartMs,
        rangeEndMs
      }),
      load: () => this.queryOverviewRows({
        assetIds,
        source,
        overviewGranularity,
        bucketMs,
        rangeStartMs,
        rangeEndMs
      })
    });
    const requestedRows = rows.filter((row) => (
      quoteCurrencies.includes(row.quote_currency.toUpperCase())
    ));
    const aggregatedRows = deriveQuoteFallbackRows({
      rows: aggregateCachedMarketRows({
        rows: requestedRows,
        granularitySeconds: overviewGranularity
      }),
      quoteCurrency,
      bridgeCurrency
    }).filter((row) => source === 'combined' || row.provider === source);
    const sourceGranularities = [...new Set(
      requestedRows.map((row) => Number(row.granularity_seconds))
    )].sort((left, right) => left - right);
    const mixedGranularity = sourceGranularities.some(
      (sourceGranularity) => sourceGranularity > resolvedGranularity
    ) || overviewGranularity > resolvedGranularity;
    const labels = new Map(
      (await labelsPromise).map((asset) => [asset.canonicalId, `${asset.symbol} · ${asset.name}`])
    );
    const series = assetIds.map((assetId) => {
      const assetRows = aggregatedRows.filter((row) => row.canonical_asset_id === assetId);
      const byBucket = Map.groupBy(assetRows, (row) => Number(row.bucket_start_ms));
      const points = [...byBucket.entries()].sort(([left], [right]) => left - right).map(([timestampMs, bucketRows]) => {
        if (chartMode === 'candlestick') {
          if (source === 'combined') {
            const candle = combineCandles({
              candles: bucketRows.map((row): CandleObservation => ({
                provider: row.provider,
                open: row.open_value ?? row.close_value,
                high: row.high_value ?? row.close_value,
                low: row.low_value ?? row.close_value,
                close: row.close_value,
                volume: row.volume_value,
                dataKind: row.data_kind,
                sampleCount: Number(row.sample_count)
              })),
              disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
            });
            return {
              timestampMs,
              ...candle,
              status: candle.disputed ? 'disputed' : candle.dataKind,
              provenance: candle.components
            };
          }
          const native = bucketRows.find((row) => row.data_kind === 'native') ?? bucketRows[0]!;
          return {
            timestampMs,
            open: native.open_value,
            high: native.high_value,
            low: native.low_value,
            close: native.close_value,
            volume: native.volume_value,
            dataKind: native.data_kind,
            status: native.data_kind,
            providers: [native.provider],
            disputed: false,
            provenance: JSON.parse(native.provenance_json) as unknown
          };
        }
        if (source === 'combined') {
          const combined = combinePriceObservations({
            observations: bucketRows.map((row): PriceObservation => ({
              provider: row.provider,
              value: row.close_value,
              dataKind: row.data_kind
            })),
            disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
          });
          return {
            timestampMs,
            ...combined
          };
        }
        const native = bucketRows.find((row) => row.data_kind === 'native') ?? bucketRows[0]!;
        return {
          timestampMs,
          value: native.close_value,
          providers: [native.provider],
          dataKind: native.data_kind,
          status: native.data_kind,
          disputed: false,
          spread: null,
          contributingValues: {
            [native.provider]: native.close_value
          }
        };
      });
      return {
        id: assetId,
        label: labels.get(assetId) ?? assetId,
        points
      };
    });
    const missingIntervals: Array<{ assetId: string; fromMs: number; toMs: number }> = [];
    for (const item of series) {
      const present = [...new Set(item.points.map((point) => point.timestampMs))]
        .filter((timestampMs) => timestampMs >= rangeStartMs && timestampMs <= rangeEndMs)
        .sort((left, right) => left - right);
      let nextExpectedBucket = fromMs === 0 && present.length > 0
        ? present[0]!
        : rangeStartMs;
      for (const bucket of present) {
        if (bucket > nextExpectedBucket) {
          missingIntervals.push({
            assetId: item.id,
            fromMs: nextExpectedBucket,
            toMs: bucket - bucketMs
          });
        }
        nextExpectedBucket = Math.max(nextExpectedBucket, bucket + bucketMs);
      }
      if (nextExpectedBucket <= rangeEndMs) {
        missingIntervals.push({
          assetId: item.id,
          fromMs: nextExpectedBucket,
          toMs: rangeEndMs
        });
      }
    }
    const [events, cursorRows] = await Promise.all([
      eventsPromise,
      this.db.query<{ last_success_at_ms: number | string | null }>({
        sql: `
          SELECT last_success_at_ms FROM market_sync_cursors
          WHERE canonical_asset_id IN (${placeholders})
            AND quote_currency IN (${quotePlaceholders})
            AND granularity_seconds <= ?
            ${source === 'combined' ? '' : 'AND provider = ?'}
        `,
        parameters: [
          ...assetIds,
          ...quoteCurrencies,
          overviewGranularity,
          ...(source === 'combined' ? [] : [source])
        ]
      })
    ]);
    const staleBoundaryMs = Date.now() - this.runtime.config.sync.staleAfterMinutes * 60_000;
    const stale = cursorRows.length > 0 && cursorRows.every((cursor) => (
      cursor.last_success_at_ms === null || Number(cursor.last_success_at_ms) < staleBoundaryMs
    ));
    return {
      source,
      chartMode,
      quoteCurrency: quoteCurrency.toUpperCase(),
      range: {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString()
      },
      requestedGranularity: granularity,
      resolvedGranularity,
      overviewGranularity,
      mixedGranularity,
      sourceGranularities,
      stale,
      partial: missingIntervals.length > 0,
      missingIntervals,
      events,
      series
    };
  }

  private async combinedPriceAt({
    canonicalAssetId,
    quoteCurrency,
    atMs
  }: {
    canonicalAssetId: string;
    quoteCurrency: string;
    atMs: number;
  }) {
    if (canonicalAssetId === quoteCurrency.toLowerCase()) return '1';
    const rows = await this.db.query<{
      provider: string;
      close_value: string;
      data_kind: 'native' | 'derived';
    }>({
      sql: `
        SELECT provider, close_value, data_kind
        FROM market_points
        WHERE canonical_asset_id = ? AND quote_currency = ?
          AND bucket_start_ms = (
            SELECT MAX(bucket_start_ms)
            FROM market_points
            WHERE canonical_asset_id = ? AND quote_currency = ?
              AND bucket_start_ms <= ?
              AND bucket_start_ms >= ?
          )
        ORDER BY provider, data_kind DESC
      `,
      parameters: [
        canonicalAssetId,
        quoteCurrency,
        canonicalAssetId,
        quoteCurrency,
        atMs,
        atMs - 14 * 24 * 60 * 60_000
      ]
    });
    const byProvider = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const current = byProvider.get(row.provider);
      if (!current || (row.data_kind === 'native' && current.data_kind !== 'native')) {
        byProvider.set(row.provider, row);
      }
    }
    return combinePriceObservations({
      observations: [...byProvider.values()].map((row) => ({
        provider: row.provider,
        value: row.close_value,
        dataKind: row.data_kind
      })),
      disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
    }).value;
  }

  async assetMetrics({
    assetIds,
    quoteCurrencies
  }: {
    assetIds: string[];
    quoteCurrencies: string[];
  }) {
    const now = Date.now();
    const monthStart = new Date();
    monthStart.setUTCHours(0, 0, 0, 0);
    monthStart.setUTCDate(1);
    const periods = {
      change24h: now - 24 * 60 * 60_000,
      change7d: now - 7 * 24 * 60 * 60_000,
      change28d: now - 28 * 24 * 60 * 60_000,
      changeMoM: now - 30 * 24 * 60 * 60_000,
      changeMtD: monthStart.getTime(),
      change3m: now - 90 * 24 * 60 * 60_000,
      change6m: now - 180 * 24 * 60 * 60_000,
      change1y: now - 365 * 24 * 60 * 60_000,
      change2y: now - 2 * 365 * 24 * 60 * 60_000,
      change4y: now - 4 * 365 * 24 * 60 * 60_000
    };
    const primaryCurrency = quoteCurrencies[0] ?? this.runtime.config.ui.defaultPrimaryCurrency;
    const assets = [];
    for (const canonicalAssetId of assetIds) {
      const prices = Object.fromEntries(await Promise.all(quoteCurrencies.map(async (quoteCurrency) => [
        quoteCurrency,
        await this.combinedPriceAt({ canonicalAssetId, quoteCurrency, atMs: now })
      ])));
      const current = prices[primaryCurrency];
      const changes: Record<string, string | null> = {};
      for (const [key, timestamp] of Object.entries(periods)) {
        const previous = await this.combinedPriceAt({
          canonicalAssetId,
          quoteCurrency: primaryCurrency,
          atMs: timestamp
        });
        changes[key] = current === null || previous === null || new Decimal(previous).isZero()
          ? null
          : new Decimal(current).minus(previous).dividedBy(previous).times(100).toString();
      }
      assets.push({ canonicalAssetId, prices, changes });
    }
    return {
      primaryCurrency,
      quoteCurrencies,
      generatedAt: new Date(now).toISOString(),
      assets
    };
  }

  providerStatus() {
    return Object.fromEntries(
      [...this.providers.entries()].map(([provider, adapter]) => [
        provider,
        {
          enabled: true,
          ...adapter.status()
        }
      ])
    );
  }
}
