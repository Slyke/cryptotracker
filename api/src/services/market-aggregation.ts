import { Decimal } from 'decimal.js';

export interface CachedMarketPoint {
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

const parseObject = (value: string) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const aggregateCachedMarketRows = <Row extends CachedMarketPoint>({
  rows,
  granularitySeconds
}: {
  rows: Row[];
  granularitySeconds: number;
}): CachedMarketPoint[] => {
  const bucketMs = granularitySeconds * 1_000;
  const bySeries = Map.groupBy(rows, (row) => `${row.provider}:${row.canonical_asset_id}:${row.quote_currency}`);
  const output: CachedMarketPoint[] = [];

  for (const seriesRows of bySeries.values()) {
    const byBucket = Map.groupBy(
      seriesRows,
      (row) => Math.floor(Number(row.bucket_start_ms) / bucketMs) * bucketMs
    );
    for (const [bucketStartMs, availableRows] of byBucket) {
      const finest = Math.min(...availableRows.map((row) => Number(row.granularity_seconds)));
      const ordered = availableRows
        .filter((row) => Number(row.granularity_seconds) === finest)
        .sort((left, right) => (
        Number(left.bucket_start_ms) - Number(right.bucket_start_ms)
        || left.provider.localeCompare(right.provider)
      ));
      const first = ordered[0]!;
      const last = ordered.at(-1)!;
      if (finest === granularitySeconds && ordered.length === 1) {
        output.push({
          ...first,
          bucket_start_ms: Number(first.bucket_start_ms),
          granularity_seconds: granularitySeconds
        });
        continue;
      }
      const volumes = ordered
        .map((row) => row.volume_value)
        .filter((value): value is string => value !== null);
      output.push({
        provider: first.provider,
        canonical_asset_id: first.canonical_asset_id,
        quote_currency: first.quote_currency,
        bucket_start_ms: bucketStartMs,
        granularity_seconds: granularitySeconds,
        data_kind: 'derived',
        open_value: first.open_value ?? first.close_value,
        high_value: Decimal.max(...ordered.map((row) => row.high_value ?? row.close_value)).toString(),
        low_value: Decimal.min(...ordered.map((row) => row.low_value ?? row.close_value)).toString(),
        close_value: last.close_value,
        volume_value: volumes.length === 0 ? null : Decimal.sum(...volumes).toString(),
        sample_count: ordered.reduce((total, row) => total + Number(row.sample_count), 0),
        finalized: ordered.every((row) => Boolean(Number(row.finalized))) ? 1 : 0,
        retrieved_at_ms: Math.max(...ordered.map((row) => Number(row.retrieved_at_ms))),
        provenance_json: JSON.stringify({
          derivedBy: 'cached-granularity-aggregation',
          sourceGranularitySeconds: finest,
          targetGranularitySeconds: granularitySeconds,
          sourcePointCount: ordered.length
        })
      });
    }
  }

  return output.sort((left, right) => (
    left.canonical_asset_id.localeCompare(right.canonical_asset_id)
    || Number(left.bucket_start_ms) - Number(right.bucket_start_ms)
    || left.provider.localeCompare(right.provider)
  ));
};

export const deriveQuoteFallbackRows = ({
  rows,
  quoteCurrency,
  bridgeCurrency
}: {
  rows: CachedMarketPoint[];
  quoteCurrency: string;
  bridgeCurrency: string;
}) => {
  const requested = quoteCurrency.toUpperCase();
  const bridge = bridgeCurrency.toUpperCase();
  const direct = rows.filter((row) => row.quote_currency.toUpperCase() === requested);
  if (requested === bridge) return direct;

  const rowKey = (row: CachedMarketPoint) => (
    `${row.provider}:${row.canonical_asset_id}:${Number(row.bucket_start_ms)}`
  );
  const directKeys = new Set(direct.map(rowKey));
  const coingecko = new Map(
    rows
      .filter((row) => row.provider === 'coingecko')
      .map((row) => [
        `${row.canonical_asset_id}:${row.quote_currency.toUpperCase()}:${Number(row.bucket_start_ms)}`,
        row
      ])
  );
  const derived: CachedMarketPoint[] = [];
  for (const source of rows) {
    if (
      source.provider === 'coingecko'
      || source.quote_currency.toUpperCase() !== bridge
      || directKeys.has(rowKey(source))
    ) {
      continue;
    }
    const lookup = (currency: string) => coingecko.get(
      `${source.canonical_asset_id}:${currency}:${Number(source.bucket_start_ms)}`
    );
    const targetRate = lookup(requested);
    const bridgeRate = lookup(bridge);
    if (!targetRate || !bridgeRate || new Decimal(bridgeRate.close_value).isZero()) continue;

    const sourceOpen = source.open_value ?? source.close_value;
    const sourceHigh = source.high_value ?? source.close_value;
    const sourceLow = source.low_value ?? source.close_value;
    const targetOpen = targetRate.open_value ?? targetRate.close_value;
    const targetHigh = targetRate.high_value ?? targetRate.close_value;
    const targetLow = targetRate.low_value ?? targetRate.close_value;
    const bridgeOpen = bridgeRate.open_value ?? bridgeRate.close_value;
    const bridgeHigh = bridgeRate.high_value ?? bridgeRate.close_value;
    const bridgeLow = bridgeRate.low_value ?? bridgeRate.close_value;
    if (
      new Decimal(bridgeOpen).isZero()
      || new Decimal(bridgeHigh).isZero()
      || new Decimal(bridgeLow).isZero()
    ) {
      continue;
    }
    derived.push({
      ...source,
      quote_currency: requested,
      data_kind: 'derived',
      open_value: new Decimal(sourceOpen).times(targetOpen).dividedBy(bridgeOpen).toString(),
      high_value: new Decimal(sourceHigh).times(targetHigh).dividedBy(bridgeLow).toString(),
      low_value: new Decimal(sourceLow).times(targetLow).dividedBy(bridgeHigh).toString(),
      close_value: new Decimal(source.close_value)
        .times(targetRate.close_value)
        .dividedBy(bridgeRate.close_value)
        .toString(),
      finalized: [source, targetRate, bridgeRate].every((row) => Boolean(Number(row.finalized))) ? 1 : 0,
      retrieved_at_ms: Math.max(
        Number(source.retrieved_at_ms),
        Number(targetRate.retrieved_at_ms),
        Number(bridgeRate.retrieved_at_ms)
      ),
      provenance_json: JSON.stringify({
        derivedBy: 'coingecko-quote-ratio',
        sourceProvider: source.provider,
        sourceQuoteCurrency: bridge,
        requestedQuoteCurrency: requested,
        source: parseObject(source.provenance_json),
        conversion: {
          provider: 'coingecko',
          target: parseObject(targetRate.provenance_json),
          bridge: parseObject(bridgeRate.provenance_json)
        }
      })
    });
  }
  return [...direct, ...derived];
};
