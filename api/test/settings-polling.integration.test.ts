import { describe, expect, it } from 'vitest';
import { bootstrapApplicationData } from '../src/services/bootstrap.js';
import { SettingsService } from '../src/services/settings.js';
import {
  effectiveMarketHistoryBackfillDays,
  marketHistoryProfiles
} from '../src/scheduler.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('per-integration polling settings', () => {
  it('provides conservative defaults and persists every independently configured interval', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    try {
      const { userId } = await bootstrapApplicationData({ db, runtime });
      const service = new SettingsService(db, runtime, userId);
      const defaults = await service.get();
      expect(defaults.pollingIntervalsMinutes).toEqual({
        marketCoinGecko: 30,
        marketCoinbase: 15,
        marketKraken: 15,
        assetCatalog: 1_440,
        addresses: 30,
        krakenAccount: 5
      });
      expect(defaults.marketHistoryBackfillDays).toBe(5 * 365);
      expect(defaults.failedJobRetentionHours).toBe(720);

      await service.patch({
        changes: {
          pollingIntervalsMinutes: {
            marketCoinGecko: 60,
            marketCoinbase: 30,
            marketKraken: 10,
            assetCatalog: 10_080,
            addresses: 15,
            krakenAccount: 5
          }
        }
      });

      expect((await service.get()).pollingIntervalsMinutes).toEqual({
        marketCoinGecko: 60,
        marketCoinbase: 30,
        marketKraken: 10,
        assetCatalog: 10_080,
        addresses: 15,
        krakenAccount: 5
      });
    } finally {
      await db.close();
    }
  });

  it('limits automatic history to the shorter of synchronization depth and retention', () => {
    expect(effectiveMarketHistoryBackfillDays({
      marketHistoryBackfillDays: 5 * 365,
      retentionDays: null
    })).toBe(5 * 365);
    expect(effectiveMarketHistoryBackfillDays({
      marketHistoryBackfillDays: 5 * 365,
      retentionDays: 2 * 365
    })).toBe(2 * 365);
    expect(effectiveMarketHistoryBackfillDays({
      marketHistoryBackfillDays: null,
      retentionDays: 2 * 365
    })).toBe(2 * 365);
    expect(effectiveMarketHistoryBackfillDays({
      marketHistoryBackfillDays: null,
      retentionDays: null
    })).toBeNull();
  });

  it('builds progressive provider-aware history profiles', () => {
    expect(marketHistoryProfiles({
      provider: 'coinbase',
      marketHistoryBackfillDays: 5 * 365,
      retentionDays: null
    })).toEqual([
      { durationMs: 90 * 24 * 60 * 60_000, granularitySeconds: 3_600 },
      { durationMs: 2 * 365 * 24 * 60 * 60_000, granularitySeconds: 86_400 },
      { durationMs: 5 * 365 * 24 * 60 * 60_000, granularitySeconds: 604_800 }
    ]);
    expect(marketHistoryProfiles({
      provider: 'kraken',
      marketHistoryBackfillDays: null,
      retentionDays: null
    }).at(-1)).toEqual({
      durationMs: null,
      granularitySeconds: 604_800
    });
    expect(marketHistoryProfiles({
      provider: 'coingecko',
      marketHistoryBackfillDays: null,
      retentionDays: null
    })).toEqual([
      { durationMs: 90 * 24 * 60 * 60_000, granularitySeconds: 3_600 },
      { durationMs: 365 * 24 * 60 * 60_000, granularitySeconds: 86_400 }
    ]);
  });
});
