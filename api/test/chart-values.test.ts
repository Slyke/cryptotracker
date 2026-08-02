import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../src/db/index.js';
import { historicalPriceLookups } from '../src/services/chart-values.js';

describe('historical chart price lookups', () => {
  it('loads every requested quote currency in one database query', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        provider: 'coingecko',
        canonical_asset_id: 'solana',
        quote_currency: 'CAD',
        bucket_start_ms: 1_000,
        granularity_seconds: 300,
        close_value: '200',
        data_kind: 'native'
      },
      {
        provider: 'coingecko',
        canonical_asset_id: 'solana',
        quote_currency: 'USD',
        bucket_start_ms: 1_000,
        granularity_seconds: 300,
        close_value: '150',
        data_kind: 'native'
      }
    ]);
    const db = { query } as unknown as AppDatabase;

    const lookups = await historicalPriceLookups({
      db,
      assetIds: ['solana'],
      quoteCurrencies: ['CAD', 'USD', 'CAD'],
      fromMs: 0,
      toMs: 2_000,
      queryGranularitySeconds: 300,
      disagreementThresholdPercent: 5
    });

    expect(query).toHaveBeenCalledOnce();
    expect(lookups.get('CAD')!({ assetId: 'solana', timestampMs: 1_000 })).toBe('200');
    expect(lookups.get('USD')!({ assetId: 'solana', timestampMs: 1_000 })).toBe('150');
  });
});
