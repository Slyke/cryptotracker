import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';

export interface SavedGraphSettings {
  id: string;
  name: string;
  type: 'market' | 'kraken' | 'addresses' | 'portfolio';
  hidden: boolean;
  config: Record<string, unknown>;
}

export interface DashboardRowSettings {
  id: string;
  name: string;
  columns: 1 | 2 | 3 | 4;
  itemIds: string[];
}

export interface DashboardSettings {
  id: string;
  rows: DashboardRowSettings[];
}

export interface SavedCalculationSettings {
  id: string;
  name: string;
  startDate: string;
  currency: string;
  principal: number;
  ratePercent: number;
  rateKind: 'apy' | 'apr';
  periodsPerYear: 1 | 12 | 52 | 365;
  durationValue: number;
  durationUnit: 'days' | 'months' | 'years';
  contributionPerPeriod: number;
  targetAmount: number | null;
}

export interface UserSettings {
  locale: string;
  timezone: string;
  theme: 'dark' | 'light';
  font: string;
  contentWidth: 'min' | '1080' | 'standard' | '1440' | '1920' | 'full';
  primaryCurrency: string;
  tooltipCurrencies: string[];
  marketSource: 'combined' | 'coingecko' | 'coinbase' | 'kraken';
  providerDisagreementThresholdPercent: number;
  costBasisMethod: 'acb' | 'fifo' | 'lifo';
  graphDefaults: Record<string, unknown>;
  pageLayouts: Record<string, string[]>;
  collapsedBlocks: Record<string, string[]>;
  accordionStates: Record<string, boolean>;
  tableColumns: Record<string, string[]>;
  tableRows: Record<string, string[]>;
  savedGraphs: SavedGraphSettings[];
  savedCalculations: SavedCalculationSettings[];
  dashboards: DashboardSettings[];
  dashboardRows: DashboardRowSettings[];
  dashboardGraphColumns: 1 | 2 | 3 | 4;
  dismissedNotices: string[];
  retentionDays: number | null;
  marketHistoryBackfillDays: number | null;
  failedJobRetentionHours: number | null;
  pollingIntervalsMinutes: {
    marketCoinGecko: number;
    marketCoinbase: number;
    marketKraken: number;
    assetCatalog: number;
    addresses: number;
    krakenAccount: number;
  };
}

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly userId: string
  ) {}

  private defaults(): UserSettings {
    const ui = this.runtime.config.ui;
    return {
      locale: ui.locale,
      timezone: ui.timezone,
      theme: ui.defaultTheme,
      font: ui.defaultFont,
      contentWidth: ui.defaultContentWidth,
      primaryCurrency: ui.defaultPrimaryCurrency,
      tooltipCurrencies: ui.defaultTooltipCurrencies,
      marketSource: ui.defaultMarketSource,
      providerDisagreementThresholdPercent: ui.defaultProviderDisagreementThresholdPercent,
      costBasisMethod: ui.defaultCostBasisMethod,
      graphDefaults: {
        range: '30d',
        granularity: 'auto',
        scale: 'linear',
        minimum: { mode: 'auto' },
        maximum: { mode: 'auto' },
        normalized: false,
        showEvents: true,
        showVolume: false
      },
      pageLayouts: {},
      collapsedBlocks: {},
      accordionStates: {},
      tableColumns: {},
      tableRows: {},
      savedGraphs: [],
      savedCalculations: [],
      dashboards: [],
      dashboardRows: [],
      dashboardGraphColumns: 2,
      dismissedNotices: [],
      retentionDays: null,
      marketHistoryBackfillDays: 5 * 365,
      failedJobRetentionHours: 720,
      pollingIntervalsMinutes: {
        marketCoinGecko: 30,
        marketCoinbase: 15,
        marketKraken: 15,
        assetCatalog: 1_440,
        addresses: 30,
        krakenAccount: 5
      }
    };
  }

  async get(): Promise<UserSettings> {
    const rows = await this.db.query<{
      setting_key: keyof UserSettings;
      setting_value_json: string;
    }>({
      sql: 'SELECT setting_key, setting_value_json FROM user_settings WHERE user_id = ? ORDER BY setting_key',
      parameters: [this.userId]
    });
    const settings = this.defaults();
    for (const row of rows) {
      try {
        (settings as unknown as Record<string, unknown>)[row.setting_key] = JSON.parse(row.setting_value_json) as unknown;
      } catch {
        continue;
      }
    }
    return settings;
  }

  async patch({ changes }: { changes: Partial<UserSettings> }) {
    const now = Date.now();
    await this.db.transaction({
      task: async (executor) => {
        for (const [key, value] of Object.entries(changes)) {
          await executor.run({
            sql: `
              INSERT INTO user_settings(user_id, setting_key, setting_value_json, updated_at_ms)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, setting_key)
              DO UPDATE SET setting_value_json = excluded.setting_value_json, updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [this.userId, key, JSON.stringify(value), now]
          });
        }
        if (changes.tooltipCurrencies) {
          await executor.run({
            sql: 'DELETE FROM selected_quote_currencies WHERE user_id = ?',
            parameters: [this.userId]
          });
          for (const [position, currency] of changes.tooltipCurrencies.entries()) {
            await executor.run({
              sql: `
                INSERT INTO selected_quote_currencies(user_id, currency, position, created_at_ms)
                VALUES (?, ?, ?, ?)
              `,
              parameters: [this.userId, currency, position, now]
            });
          }
        }
      }
    });
    return this.get();
  }

  getPublicRuntime() {
    return {
      appName: this.runtime.config.appName,
      defaults: {
        locale: this.runtime.config.ui.locale,
        timezone: this.runtime.config.ui.timezone,
        theme: this.runtime.config.ui.defaultTheme,
        font: this.runtime.config.ui.defaultFont,
        contentWidth: this.runtime.config.ui.defaultContentWidth
      },
      providers: {
        market: Object.fromEntries(
          Object.entries(this.runtime.config.providers.market).map(([provider, value]) => [
            provider,
            { enabled: value.enabled }
          ])
        ),
        chains: Object.fromEntries(
          Object.entries(this.runtime.config.providers.chains).map(([network, value]) => [
            network,
            {
              enabled: value.enabled,
              provider: value.provider
            }
          ])
        )
      }
    };
  }
}
