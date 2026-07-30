import type { LoadedRuntime } from './config/load.js';
import type { AppDatabase } from './db/index.js';
import type { Logger } from './logging/logger.js';
import type { AddressService } from './services/addresses.js';
import type { KrakenService } from './services/kraken.js';
import type { MarketService } from './services/market.js';
import type { PortfolioService } from './services/portfolio.js';
import type { RetentionService } from './services/retention.js';
import type { SettingsService } from './services/settings.js';

const DAY_MS = 24 * 60 * 60_000;
const HOUR_HISTORY_DAYS = 90;
const DAILY_HISTORY_DAYS = 2 * 365;
const COINGECKO_DAILY_HISTORY_DAYS = 365;

export interface MarketHistoryProfile {
  durationMs: number | null;
  granularitySeconds: 3_600 | 86_400 | 604_800;
}

export const effectiveMarketHistoryBackfillDays = ({
  marketHistoryBackfillDays,
  retentionDays
}: {
  marketHistoryBackfillDays: number | null;
  retentionDays: number | null;
}) => {
  if (marketHistoryBackfillDays === null) return retentionDays;
  if (retentionDays === null) return marketHistoryBackfillDays;
  return Math.min(marketHistoryBackfillDays, retentionDays);
};

export const marketHistoryProfiles = ({
  provider,
  marketHistoryBackfillDays,
  retentionDays
}: {
  provider: 'coingecko' | 'coinbase' | 'kraken';
  marketHistoryBackfillDays: number | null;
  retentionDays: number | null;
}): MarketHistoryProfile[] => {
  const effectiveDays = effectiveMarketHistoryBackfillDays({
    marketHistoryBackfillDays,
    retentionDays
  });
  const profiles: MarketHistoryProfile[] = [{
    durationMs: Math.min(effectiveDays ?? HOUR_HISTORY_DAYS, HOUR_HISTORY_DAYS) * DAY_MS,
    granularitySeconds: 3_600
  }];
  if (effectiveDays === null || effectiveDays > HOUR_HISTORY_DAYS) {
    const dailyLimitDays = provider === 'coingecko'
      ? COINGECKO_DAILY_HISTORY_DAYS
      : DAILY_HISTORY_DAYS;
    profiles.push({
      durationMs: Math.min(effectiveDays ?? dailyLimitDays, dailyLimitDays) * DAY_MS,
      granularitySeconds: 86_400
    });
  }
  if (
    provider !== 'coingecko'
    && (effectiveDays === null || effectiveDays > DAILY_HISTORY_DAYS)
  ) {
    profiles.push({
      durationMs: effectiveDays === null ? null : effectiveDays * DAY_MS,
      granularitySeconds: 604_800
    });
  }
  return profiles;
};

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastScheduledAt = new Map<string, number>();

  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly market: MarketService,
    private readonly addresses: AddressService,
    private readonly kraken: KrakenService,
    private readonly portfolio: PortfolioService,
    private readonly settings: SettingsService,
    private readonly retention: RetentionService,
    private readonly logger: Logger
  ) {}

  private due({
    key,
    intervalMinutes,
    now
  }: {
    key: string;
    intervalMinutes: number;
    now: number;
  }) {
    const safeIntervalMinutes = Math.max(5, Math.floor(intervalMinutes));
    const previous = this.lastScheduledAt.get(key);
    if (previous !== undefined && now - previous < safeIntervalMinutes * 60_000) return false;
    this.lastScheduledAt.set(key, now);
    return true;
  }

  private async scheduleCycle() {
    try {
      const now = Date.now();
      const fromMs = now - ((this.runtime.config.sync.overlapBuckets + 1) * 300_000);
      const settings = await this.settings.get();
      const intervals = settings.pollingIntervalsMinutes;
      if (this.due({
        key: 'asset-catalog',
        intervalMinutes: intervals.assetCatalog,
        now
      })) {
        await this.market.queueCatalogRefresh();
      }
      if (this.due({ key: 'retention', intervalMinutes: 30, now })) {
        await this.retention.applyAllScheduled({
          retentionDays: settings.retentionDays,
          failedJobRetentionHours: settings.failedJobRetentionHours
        });
      }
      if (this.due({ key: 'portfolio-snapshot', intervalMinutes: 30, now })) {
        await this.portfolio.capture();
      }
      const quoteCurrencies = [...new Set([
        settings.primaryCurrency,
        ...settings.tooltipCurrencies
      ])];
      const historyBackfillLimitPerCycle = 6;
      let historyBackfillsQueued = 0;
      const watchedAssetIds = (await this.market.listWatchlist())
        .filter((asset) => asset.enabled)
        .map((asset) => asset.canonicalId);
      const assetIds = [...new Set(watchedAssetIds)];
      const marketProviderIntervals = {
        coingecko: intervals.marketCoinGecko,
        coinbase: intervals.marketCoinbase,
        kraken: intervals.marketKraken
      } as const;
      const dueMarketProviders = new Set(
        Object.entries(marketProviderIntervals)
          .filter(([provider, intervalMinutes]) => this.due({
            key: `market:${provider}`,
            intervalMinutes,
            now
          }))
          .map(([provider]) => provider)
      );
      if (dueMarketProviders.size > 0) {
        for (const canonicalAssetId of assetIds) {
          const providers = await this.market.providersForAsset({ canonicalAssetId });
          for (const quoteCurrency of quoteCurrencies) {
            for (const provider of providers.filter((candidate) => dueMarketProviders.has(candidate))) {
              await this.market.queueBackfill({
                provider,
                canonicalAssetId,
                quoteCurrency,
                fromMs,
                toMs: now,
                granularitySeconds: 300
              });
              if (historyBackfillsQueued >= historyBackfillLimitPerCycle) continue;
              const providerHistoryProfiles = marketHistoryProfiles({
                provider: provider as 'coingecko' | 'coinbase' | 'kraken',
                marketHistoryBackfillDays: settings.marketHistoryBackfillDays,
                retentionDays: settings.retentionDays
              });
              for (const profile of providerHistoryProfiles) {
                if (historyBackfillsQueued >= historyBackfillLimitPerCycle) break;
                const providerDurationMs = profile.durationMs === null
                  ? null
                  : provider === 'kraken'
                    ? Math.min(profile.durationMs, 720 * profile.granularitySeconds * 1_000)
                    : profile.durationMs;
                const queued = await this.market.queueBackfillIfNeeded({
                  provider,
                  canonicalAssetId,
                  quoteCurrency,
                  fromMs: providerDurationMs === null ? 0 : now - providerDurationMs,
                  toMs: now,
                  granularitySeconds: profile.granularitySeconds
                });
                if ('coalesced' in queued && queued.coalesced === false) {
                  historyBackfillsQueued += 1;
                }
              }
            }
          }
        }
      }
      if (this.due({
        key: 'addresses',
        intervalMinutes: intervals.addresses,
        now
      })) {
        const cycle = Math.floor(now / (intervals.addresses * 60_000));
        const addresses = (await this.addresses.list()).filter((address) => address.enabled);
        for (const address of addresses) {
          await this.addresses.queueRefresh({
            id: address.id,
            priority: 30,
            reason: `scheduled-${cycle}`
          });
        }
      }
      if (
        this.due({
          key: 'kraken-account',
          intervalMinutes: intervals.krakenAccount,
          now
        })
        && (await this.kraken.status()).configured
      ) {
        const cycle = Math.floor(now / (intervals.krakenAccount * 60_000));
        await this.kraken.queueRefresh({
          reason: `scheduled-${cycle}`,
          priority: 30
        });
      }
    } catch (error) {
      this.logger.error({
        caller: 'scheduler::cycle',
        message: 'Scheduled synchronization cycle failed.',
        error
      });
    }
  }

  start() {
    if (this.timer) return;
    const intervalMs = 60_000;
    this.timer = setInterval(() => void this.scheduleCycle(), intervalMs);
    this.timer.unref();
    void this.scheduleCycle();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async status() {
    const queue = await this.db.one<{ count: number | string }>({
      sql: `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running', 'retry')`
    });
    const settings = await this.settings.get();
    return {
      pollMinutes: 1,
      pollingIntervalsMinutes: settings.pollingIntervalsMinutes,
      running: this.timer !== null,
      queueDepth: Number(queue?.count ?? 0)
    };
  }
}
