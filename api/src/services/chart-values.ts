import { Decimal } from 'decimal.js';
import type { AppDatabase } from '../db/index.js';
import { combinePriceObservations } from '../domain/market.js';

export interface ChartDenominationOption {
  id: string;
  symbol: string;
  label: string;
}

export const chartDenominationsAt = ({
  denominationOptions,
  quoteValues,
  primaryCurrency,
  timestampMs,
  priceAt
}: {
  denominationOptions: ChartDenominationOption[];
  quoteValues: Record<string, string | null | undefined>;
  primaryCurrency: string;
  timestampMs: number;
  priceAt: (input: {
    assetId: string;
    quoteCurrency: string;
    timestampMs: number;
  }) => string | null;
}) => {
  const primary = primaryCurrency.toUpperCase();
  const currencies = [
    primary,
    'USD'
  ].filter((currency, index, values) => values.indexOf(currency) === index);
  const denominations: Record<string, string | null> = {};
  const denominationFallbacks: Record<string, string> = {};
  for (const option of denominationOptions) {
    denominations[option.id] = null;
    for (const quoteCurrency of currencies) {
      const quoteValue = quoteValues[quoteCurrency];
      if (quoteValue === null || quoteValue === undefined) continue;
      const unitPrice = priceAt({
        assetId: option.id,
        quoteCurrency,
        timestampMs
      });
      if (unitPrice === null || new Decimal(unitPrice).isZero()) continue;
      denominations[option.id] = new Decimal(quoteValue).dividedBy(unitPrice).toString();
      if (quoteCurrency !== primary) {
        denominationFallbacks[option.id] = quoteCurrency;
      }
      break;
    }
  }
  return {
    denominations,
    denominationFallbacks
  };
};

interface HistoricalPriceRow {
  provider: string;
  canonical_asset_id: string;
  bucket_start_ms: number | string;
  granularity_seconds: number | string;
  close_value: string;
  data_kind: 'native' | 'derived';
}

export const enabledChartDenominations = async ({
  db
}: {
  db: AppDatabase;
}): Promise<ChartDenominationOption[]> => {
  const rows = await db.query<{
    canonical_id: string;
    symbol: string;
    name: string;
  }>({
    sql: `
      SELECT canonical_id, symbol, name
      FROM watched_assets
      WHERE enabled = 1
      ORDER BY symbol, canonical_id
    `
  });
  return rows.map((row) => ({
    id: row.canonical_id,
    symbol: row.symbol.toUpperCase(),
    label: `${row.symbol.toUpperCase()} · ${row.name}`
  }));
};

export const historicalPriceLookup = async ({
  db,
  assetIds,
  quoteCurrency,
  fromMs,
  toMs,
  queryGranularitySeconds,
  disagreementThresholdPercent
}: {
  db: AppDatabase;
  assetIds: string[];
  quoteCurrency: string;
  fromMs: number;
  toMs: number;
  queryGranularitySeconds?: number;
  disagreementThresholdPercent: number;
}) => {
  const normalizedAssetIds = [...new Set(assetIds.filter(Boolean))];
  const currency = quoteCurrency.toUpperCase();
  const rows = normalizedAssetIds.length === 0
    ? []
    : await db.query<HistoricalPriceRow>({
        sql: `
          WITH ranked_points AS (
            SELECT provider, canonical_asset_id, bucket_start_ms,
                   granularity_seconds, close_value, data_kind,
                   ROW_NUMBER() OVER (
                     PARTITION BY provider, canonical_asset_id,
                                  CAST(bucket_start_ms / ? AS INTEGER)
                     ORDER BY bucket_start_ms DESC,
                              granularity_seconds ASC,
                              CASE WHEN data_kind = 'native' THEN 0 ELSE 1 END
                   ) AS bucket_rank
            FROM market_points
            WHERE canonical_asset_id IN (${normalizedAssetIds.map(() => '?').join(', ')})
              AND quote_currency = ?
              AND bucket_start_ms >= ?
              AND bucket_start_ms <= ?
          )
          SELECT provider, canonical_asset_id, bucket_start_ms,
                 granularity_seconds, close_value, data_kind
          FROM ranked_points
          WHERE bucket_rank = 1
          ORDER BY canonical_asset_id, bucket_start_ms,
                   granularity_seconds, provider, data_kind DESC
        `,
        parameters: [
          Math.max(1, Math.floor(queryGranularitySeconds ?? 300)) * 1_000,
          ...normalizedAssetIds,
          currency,
          Math.max(0, fromMs - 7 * 24 * 60 * 60_000),
          toMs
        ]
      });
  const byAsset = Map.groupBy(rows, (row) => row.canonical_asset_id);
  const cache = new Map<string, string | null>();

  return ({
    assetId,
    timestampMs
  }: {
    assetId: string;
    timestampMs: number;
  }) => {
    const cacheKey = `${assetId}:${timestampMs}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
    const candidates = byAsset.get(assetId) ?? [];
    let left = 0;
    let right = candidates.length - 1;
    let found = -1;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      if (Number(candidates[middle]!.bucket_start_ms) <= timestampMs) {
        found = middle;
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }
    if (found < 0) {
      cache.set(cacheKey, null);
      return null;
    }
    const bucketStartMs = Number(candidates[found]!.bucket_start_ms);
    if (bucketStartMs < timestampMs - 7 * 24 * 60 * 60_000) {
      cache.set(cacheKey, null);
      return null;
    }
    let first = found;
    while (
      first > 0
      && Number(candidates[first - 1]!.bucket_start_ms) === bucketStartMs
    ) {
      first -= 1;
    }
    const observations: HistoricalPriceRow[] = [];
    for (
      let index = first;
      index < candidates.length
      && Number(candidates[index]!.bucket_start_ms) === bucketStartMs;
      index += 1
    ) {
      observations.push(candidates[index]!);
    }
    const finestGranularity = Math.min(
      ...observations.map((observation) => Number(observation.granularity_seconds))
    );
    const value = combinePriceObservations({
      observations: observations
        .filter((observation) => Number(observation.granularity_seconds) === finestGranularity)
        .map((observation) => ({
          provider: observation.provider,
          value: observation.close_value,
          dataKind: observation.data_kind
        })),
      disagreementThresholdPercent
    }).value;
    cache.set(cacheKey, value);
    return value;
  };
};
