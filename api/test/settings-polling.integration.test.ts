import { describe, expect, it } from 'vitest';
import { bootstrapApplicationData } from '../src/services/bootstrap.js';
import { SettingsService } from '../src/services/settings.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('per-integration polling settings', () => {
  it('provides conservative defaults and persists every independently configured interval', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    try {
      const { userId } = await bootstrapApplicationData({ db, runtime });
      const service = new SettingsService(db, runtime, userId);
      expect((await service.get()).pollingIntervalsMinutes).toEqual({
        marketCoinGecko: 30,
        marketCoinbase: 15,
        marketKraken: 15,
        assetCatalog: 1_440,
        addresses: 30,
        krakenAccount: 5
      });

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
});
