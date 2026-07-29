import { Decimal } from 'decimal.js';
import type { RuntimeConfig, RuntimeSecrets } from '../config/schema.js';
import { AppError } from '../errors.js';
import { createProviderHttpClient, type ProviderHttpClient } from './http.js';
import { ProviderRateLimiter } from './rate-limiter.js';

export interface ProviderCandle {
  bucketStartMs: number;
  granularitySeconds: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  finalized: boolean;
  dataKind: 'native' | 'derived';
  provenance: Record<string, unknown>;
}

export interface MarketPair {
  canonicalAssetId: string;
  quoteCurrency: string;
  providerAssetId: string;
  providerSymbol: string;
  pairId: string;
}

export interface MarketCatalogAsset {
  canonicalId: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  providerAssetId: string;
  providerSymbol: string;
  metadata: Record<string, unknown>;
}

export interface MarketProviderAdapter {
  readonly provider: 'coingecko' | 'coinbase' | 'kraken';
  fetchCatalog?: ({
    quoteCurrency,
    limit
  }: {
    quoteCurrency: string;
    limit: number;
  }) => Promise<MarketCatalogAsset[]>;
  fetchCandles({
    pair,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    pair: MarketPair;
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }): Promise<ProviderCandle[]>;
  status(): ReturnType<ProviderRateLimiter['getStatus']>;
}

const coingeckoObservedGranularity = ({
  timestamps,
  requested
}: {
  timestamps: number[];
  requested: number;
}) => {
  const ordered = [...new Set(timestamps)].sort((left, right) => left - right);
  const intervals = ordered.slice(1)
    .map((timestamp, index) => timestamp - ordered[index]!)
    .filter((interval) => interval > 0)
    .sort((left, right) => left - right);
  if (intervals.length === 0) return requested;
  const medianMs = intervals[Math.floor(intervals.length / 2)]!;
  const observedSeconds = Math.max(1, Math.round(medianMs / 1_000));
  const commonIntervals = [60, 300, 900, 1_800, 3_600, 14_400, 86_400, 604_800];
  const nearest = commonIntervals.reduce((current, candidate) => (
    Math.abs(candidate - observedSeconds) < Math.abs(current - observedSeconds)
      ? candidate
      : current
  ));
  const normalizedObserved = Math.abs(nearest - observedSeconds) / nearest <= 0.2
    ? nearest
    : observedSeconds;
  return normalizedObserved;
};

const COINGECKO_MAX_INTRADAY_RANGE_MS = 30 * 24 * 60 * 60_000;

const coingeckoRequestWindows = ({
  fromMs,
  toMs,
  granularitySeconds
}: {
  fromMs: number;
  toMs: number;
  granularitySeconds: number;
}) => {
  if (toMs < fromMs) return [];
  if (granularitySeconds >= 86_400 || toMs === fromMs) return [{ fromMs, toMs }];
  const windows: Array<{ fromMs: number; toMs: number }> = [];
  let windowStartMs = fromMs;
  while (windowStartMs < toMs) {
    const windowEndMs = Math.min(toMs, windowStartMs + COINGECKO_MAX_INTRADAY_RANGE_MS);
    windows.push({ fromMs: windowStartMs, toMs: windowEndMs });
    windowStartMs = windowEndMs;
  }
  return windows;
};

const coingeckoAdapter = ({
  config,
  secrets
}: {
  config: RuntimeConfig['providers']['market']['coinGecko'];
  secrets: RuntimeSecrets;
}): MarketProviderAdapter => {
  const limiter = new ProviderRateLimiter('coingecko', config.rate);
  const client = createProviderHttpClient({
    provider: 'coingecko',
    baseUrl: config.baseUrl,
    limiter,
    allowedPaths: [
      /^\/coins\/markets$/,
      /^\/coins\/[^/]+\/market_chart\/range$/
    ]
  });
  return {
    provider: 'coingecko',
    fetchCatalog: async ({ quoteCurrency, limit }) => {
      const headers = secrets.providers.coinGeckoApiKey
        ? { 'x-cg-demo-api-key': secrets.providers.coinGeckoApiKey }
        : {};
      const data = await client.json<Array<{
        id: string;
        symbol: string;
        name: string;
        market_cap_rank?: number | null;
        image?: string | null;
      }>>({
        path: '/coins/markets',
        query: {
          vs_currency: quoteCurrency.toLowerCase(),
          order: 'market_cap_desc',
          per_page: Math.min(100, Math.max(1, limit)),
          page: 1,
          sparkline: 'false'
        },
        headers
      });
      return data.map((asset) => ({
        canonicalId: asset.id,
        symbol: asset.symbol.toUpperCase(),
        name: asset.name,
        marketCapRank: asset.market_cap_rank ?? null,
        providerAssetId: asset.id,
        providerSymbol: asset.symbol.toLowerCase(),
        metadata: { image: asset.image ?? null }
      }));
    },
    fetchCandles: async ({ pair, fromMs, toMs, granularitySeconds }) => {
      const headers = secrets.providers.coinGeckoApiKey
        ? { 'x-cg-demo-api-key': secrets.providers.coinGeckoApiKey }
        : {};
      const data = await client.json<{
        prices?: Array<[number, number]>;
        total_volumes?: Array<[number, number]>;
      }>({
        path: `/coins/${encodeURIComponent(pair.providerAssetId)}/market_chart/range`,
        query: {
          vs_currency: pair.quoteCurrency.toLowerCase(),
          from: Math.floor(fromMs / 1_000),
          to: Math.ceil(toMs / 1_000),
          precision: 'full'
        },
        headers
      });
      const observedGranularitySeconds = coingeckoObservedGranularity({
        timestamps: (data.prices ?? []).map(([timestamp]) => timestamp),
        requested: granularitySeconds
      });
      const effectiveGranularitySeconds = Math.max(
        granularitySeconds,
        observedGranularitySeconds
      );
      const bucketMs = effectiveGranularitySeconds * 1_000;
      const volumeByBucket = new Map(
        (data.total_volumes ?? []).map(([timestamp, volume]) => [
          Math.floor(timestamp / bucketMs) * bucketMs,
          String(volume)
        ])
      );
      const grouped = new Map<number, Array<[number, string]>>();
      for (const [timestamp, price] of data.prices ?? []) {
        const bucket = Math.floor(timestamp / bucketMs) * bucketMs;
        const samples = grouped.get(bucket) ?? [];
        samples.push([timestamp, String(price)]);
        grouped.set(bucket, samples);
      }
      return [...grouped.entries()].sort(([left], [right]) => left - right).flatMap(([bucketStartMs, samples]) => {
        const ordered = samples.sort(([left], [right]) => left - right);
        if (ordered.length === 0) return [];
        const prices = ordered.map(([, price]) => new Decimal(price));
        return [{
          bucketStartMs,
          granularitySeconds: effectiveGranularitySeconds,
          open: ordered[0]![1],
          high: Decimal.max(...prices).toString(),
          low: Decimal.min(...prices).toString(),
          close: ordered.at(-1)![1],
          volume: volumeByBucket.get(bucketStartMs) ?? null,
          finalized: (bucketStartMs + bucketMs) < Date.now(),
          dataKind: 'derived' as const,
          provenance: {
            endpoint: 'market_chart/range',
            nativePointSamples: ordered.length,
            derivedOhlc: true,
            requestedGranularitySeconds: granularitySeconds,
            observedGranularitySeconds,
            effectiveGranularitySeconds
          }
        }];
      });
    },
    status: () => limiter.getStatus()
  };
};

const coinbaseGranularity = ({ requested }: { requested: number }) => {
  const supported = [60, 300, 900, 3_600, 21_600, 86_400];
  return supported.find((value) => value >= requested) ?? 86_400;
};

const COINBASE_MAX_CANDLES_PER_REQUEST = 300;

const coinbaseRequestWindows = ({
  fromMs,
  toMs,
  granularitySeconds
}: {
  fromMs: number;
  toMs: number;
  granularitySeconds: number;
}) => {
  if (toMs < fromMs) return [];

  const resolvedGranularity = coinbaseGranularity({ requested: granularitySeconds });
  const bucketMs = resolvedGranularity * 1_000;
  const firstBucketMs = Math.floor(fromMs / bucketMs) * bucketMs;
  const lastBucketMs = Math.floor(toMs / bucketMs) * bucketMs;
  const windows: Array<{ fromMs: number; toMs: number }> = [];

  for (let windowStartMs = firstBucketMs; windowStartMs <= lastBucketMs;) {
    const windowEndMs = Math.min(
      lastBucketMs,
      windowStartMs + ((COINBASE_MAX_CANDLES_PER_REQUEST - 1) * bucketMs)
    );
    windows.push({ fromMs: windowStartMs, toMs: windowEndMs });
    windowStartMs = windowEndMs + bucketMs;
  }

  return windows;
};

const coinbaseAdapter = ({
  config
}: {
  config: RuntimeConfig['providers']['market']['coinbase'];
}): MarketProviderAdapter => {
  const limiter = new ProviderRateLimiter('coinbase', config.rate);
  const client = createProviderHttpClient({
    provider: 'coinbase',
    baseUrl: config.baseUrl,
    limiter,
    allowedPaths: [/^\/products\/[^/]+\/candles$/]
  });
  return {
    provider: 'coinbase',
    fetchCandles: async ({ pair, fromMs, toMs, granularitySeconds }) => {
      const resolvedGranularity = coinbaseGranularity({ requested: granularitySeconds });
      const bucketMs = resolvedGranularity * 1_000;
      const rangeStartMs = Math.floor(fromMs / bucketMs) * bucketMs;
      const rangeEndMs = Math.floor(toMs / bucketMs) * bucketMs;
      const data = await client.json<Array<[number, number, number, number, number, number]>>({
        path: `/products/${encodeURIComponent(pair.pairId)}/candles`,
        query: {
          start: new Date(rangeStartMs).toISOString(),
          end: new Date(rangeEndMs + bucketMs).toISOString(),
          granularity: resolvedGranularity
        }
      });
      return data
        .map(([seconds, low, high, open, close, volume]) => ({
          bucketStartMs: seconds * 1_000,
          granularitySeconds: resolvedGranularity,
          open: String(open),
          high: String(high),
          low: String(low),
          close: String(close),
          volume: String(volume),
          finalized: ((seconds + resolvedGranularity) * 1_000) < Date.now(),
          dataKind: 'native' as const,
          provenance: {
            endpoint: 'products/candles',
            requestedGranularitySeconds: granularitySeconds,
            nativeGranularitySeconds: resolvedGranularity
          }
        }))
        .filter((candle) => (
          candle.bucketStartMs >= rangeStartMs
          && candle.bucketStartMs <= rangeEndMs
        ))
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    },
    status: () => limiter.getStatus()
  };
};

const krakenIntervalMinutes = ({ requested }: { requested: number }) => {
  const supported = [1, 5, 15, 30, 60, 240, 1_440, 10_080, 21_600];
  const minutes = Math.ceil(requested / 60);
  return supported.find((value) => value >= minutes) ?? 21_600;
};

const krakenMarketAdapter = ({
  config
}: {
  config: RuntimeConfig['providers']['market']['kraken'];
}): MarketProviderAdapter => {
  const limiter = new ProviderRateLimiter('kraken-market', config.rate);
  const client = createProviderHttpClient({
    provider: 'kraken-market',
    baseUrl: config.baseUrl,
    limiter,
    allowedPaths: [/^\/0\/public\/OHLC$/]
  });
  return {
    provider: 'kraken',
    fetchCandles: async ({ pair, fromMs, granularitySeconds }) => {
      const interval = krakenIntervalMinutes({ requested: granularitySeconds });
      const data = await client.json<{
        error?: string[];
        result?: Record<string, Array<[number, string, string, string, string, string, string, number]> | number>;
      }>({
        path: '/0/public/OHLC',
        query: {
          pair: pair.pairId,
          interval,
          since: Math.floor(fromMs / 1_000)
        }
      });
      if ((data.error ?? []).length > 0) {
        throw new AppError({
          errorKey: 'PROVIDER_REQUEST_FAILED',
          reason: `Kraken market API rejected the request: ${(data.error ?? []).join(', ')}`,
          status: 502
        });
      }
      const rows = Object.entries(data.result ?? {})
        .find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1] as Array<[number, string, string, string, string, string, string, number]> | undefined;
      return (rows ?? []).map(([seconds, open, high, low, close, _vwap, volume, count]) => ({
        bucketStartMs: seconds * 1_000,
        granularitySeconds: interval * 60,
        open,
        high,
        low,
        close,
        volume,
        finalized: ((seconds + (interval * 60)) * 1_000) < Date.now(),
        dataKind: 'native' as const,
        provenance: {
          endpoint: '0/public/OHLC',
          intervalMinutes: interval,
          tradeCount: count
        }
      }));
    },
    status: () => limiter.getStatus()
  };
};

export const createMarketProviders = ({
  config,
  secrets
}: {
  config: RuntimeConfig;
  secrets: RuntimeSecrets;
}) => {
  const providers = new Map<string, MarketProviderAdapter>();
  if (config.providers.market.coinGecko.enabled) {
    providers.set('coingecko', coingeckoAdapter({
      config: config.providers.market.coinGecko,
      secrets
    }));
  }
  if (config.providers.market.coinbase.enabled) {
    providers.set('coinbase', coinbaseAdapter({
      config: config.providers.market.coinbase
    }));
  }
  if (config.providers.market.kraken.enabled) {
    providers.set('kraken', krakenMarketAdapter({
      config: config.providers.market.kraken
    }));
  }
  return providers;
};

export const marketProviderInternals = {
  coingeckoObservedGranularity,
  coingeckoRequestWindows,
  coinbaseGranularity,
  coinbaseRequestWindows,
  krakenIntervalMinutes
};
