import { describe, expect, it } from 'vitest';
import {
  aggregateCachedMarketRows,
  deriveQuoteFallbackRows,
  type CachedMarketPoint
} from '../src/services/market-aggregation.js';

const point = (changes: Partial<CachedMarketPoint> = {}): CachedMarketPoint => ({
  provider: 'coinbase',
  canonical_asset_id: 'bitcoin',
  quote_currency: 'CAD',
  bucket_start_ms: 0,
  granularity_seconds: 60,
  data_kind: 'native',
  open_value: '100',
  high_value: '110',
  low_value: '90',
  close_value: '105',
  volume_value: '2',
  sample_count: 1,
  finalized: 1,
  retrieved_at_ms: 10,
  provenance_json: '{"fixture":true}',
  ...changes
});

describe('cached market resolution', () => {
  it('aggregates only finer data and retains exact decimal OHLC and volume', () => {
    expect(aggregateCachedMarketRows({
      granularitySeconds: 120,
      rows: [
        point(),
        point({
          bucket_start_ms: 60_000,
          open_value: '105',
          high_value: '120.000000000000000001',
          low_value: '95',
          close_value: '115',
          volume_value: '3.1'
        })
      ]
    })).toEqual([
      expect.objectContaining({
        bucket_start_ms: 0,
        granularity_seconds: 120,
        data_kind: 'derived',
        open_value: '100',
        high_value: '120.000000000000000001',
        low_value: '90',
        close_value: '115',
        volume_value: '5.1',
        sample_count: 2
      })
    ]);
  });

  it('uses the finest available rows in each target bucket without dropping older coarse history', () => {
    expect(aggregateCachedMarketRows({
      granularitySeconds: 3_600,
      rows: [
        point({
          bucket_start_ms: 0,
          granularity_seconds: 3_600,
          close_value: '90'
        }),
        point({
          bucket_start_ms: 3_600_000,
          granularity_seconds: 3_600,
          close_value: '100'
        }),
        point({
          bucket_start_ms: 3_600_000,
          granularity_seconds: 300,
          close_value: '101'
        }),
        point({
          bucket_start_ms: 3_900_000,
          granularity_seconds: 300,
          close_value: '102'
        })
      ]
    }).map((row) => ({
      bucket: row.bucket_start_ms,
      close: row.close_value,
      sourceGranularity: JSON.parse(row.provenance_json).sourceGranularitySeconds
        ?? row.granularity_seconds
    }))).toEqual([
      { bucket: 0, close: '90', sourceGranularity: 3_600 },
      { bucket: 3_600_000, close: '102', sourceGranularity: 300 }
    ]);
  });

  it('keeps sparse coarse history when a finer zoom resolution is requested', () => {
    expect(aggregateCachedMarketRows({
      granularitySeconds: 900,
      rows: [
        point({
          bucket_start_ms: 0,
          granularity_seconds: 86_400,
          close_value: '90'
        }),
        point({
          bucket_start_ms: 900_000,
          granularity_seconds: 300,
          close_value: '101'
        }),
        point({
          bucket_start_ms: 1_200_000,
          granularity_seconds: 300,
          close_value: '102'
        })
      ]
    }).map((row) => ({
      bucket: row.bucket_start_ms,
      close: row.close_value,
      sourceGranularity: JSON.parse(row.provenance_json).sourceGranularitySeconds
        ?? row.granularity_seconds
    }))).toEqual([
      { bucket: 0, close: '90', sourceGranularity: 86_400 },
      { bucket: 900_000, close: '102', sourceGranularity: 300 }
    ]);
  });

  it('prefers a direct quote and otherwise uses a same-bucket CoinGecko ratio', () => {
    const rows = [
      point({ quote_currency: 'USD', close_value: '100', open_value: '90', high_value: '110', low_value: '80' }),
      point({
        provider: 'coingecko',
        quote_currency: 'USD',
        close_value: '98',
        open_value: '88',
        high_value: '108',
        low_value: '78'
      }),
      point({
        provider: 'coingecko',
        quote_currency: 'CAD',
        close_value: '140',
        open_value: '130',
        high_value: '150',
        low_value: '120'
      })
    ];
    const derived = deriveQuoteFallbackRows({
      rows,
      quoteCurrency: 'CAD',
      bridgeCurrency: 'USD'
    });
    expect(derived.find((row) => row.provider === 'coinbase')).toMatchObject({
      quote_currency: 'CAD',
      data_kind: 'derived',
      close_value: '142.85714285714285714'
    });
    expect(JSON.parse(derived.find((row) => row.provider === 'coinbase')!.provenance_json)).toMatchObject({
      derivedBy: 'coingecko-quote-ratio',
      sourceProvider: 'coinbase'
    });

    const withDirect = deriveQuoteFallbackRows({
      rows: [...rows, point({ quote_currency: 'CAD', close_value: '145' })],
      quoteCurrency: 'CAD',
      bridgeCurrency: 'USD'
    });
    expect(withDirect.filter((row) => row.provider === 'coinbase')).toHaveLength(1);
    expect(withDirect.find((row) => row.provider === 'coinbase')?.close_value).toBe('145');
  });
});
