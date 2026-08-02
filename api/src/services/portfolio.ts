import { Decimal } from 'decimal.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import {
  boundedOverviewGranularity,
  resolveAutoGranularity
} from '../domain/graphs.js';
import { canonicalKrakenAsset } from '../domain/kraken-assets.js';
import { createId } from '../utils/ids.js';
import {
  chartDenominationsAt,
  enabledChartDenominations,
  historicalPriceLookup,
  historicalPriceLookups
} from './chart-values.js';
import { addressEvents, krakenEvents } from './event-markers.js';

interface PortfolioSnapshotRow {
  id: string;
  captured_at_ms: number | string;
  primary_currency: string;
  values_json: string;
  quantities_json: string;
  priced_coverage_percent: string;
  incomplete_balance_count: number | string;
  provenance_json: string;
}

const parseRecord = (value: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, entry]) => typeof entry === 'string')
        .map(([key, entry]) => [key, String(entry)])
    );
  } catch {
    return {};
  }
};

const addQuantity = ({
  quantities,
  assetId,
  quantity
}: {
  quantities: Map<string, Decimal>;
  assetId: string;
  quantity: string;
}) => {
  quantities.set(
    assetId,
    (quantities.get(assetId) ?? new Decimal(0)).plus(quantity)
  );
};

export class PortfolioService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime
  ) {}

  private async configuredCurrencies() {
    const rows = await this.db.query<{
      setting_key: string;
      setting_value_json: string;
    }>({
      sql: `
        SELECT setting_key, setting_value_json
        FROM user_settings
        WHERE setting_key IN ('primaryCurrency', 'tooltipCurrencies')
        ORDER BY updated_at_ms DESC
      `
    });
    const latest = new Map<string, unknown>();
    for (const row of rows) {
      if (latest.has(row.setting_key)) continue;
      try {
        latest.set(row.setting_key, JSON.parse(row.setting_value_json) as unknown);
      } catch {
        continue;
      }
    }
    const configuredPrimary = latest.get('primaryCurrency');
    const primaryCurrency = typeof configuredPrimary === 'string'
      ? configuredPrimary.toUpperCase()
      : this.runtime.config.ui.defaultPrimaryCurrency;
    const configuredTooltips = latest.get('tooltipCurrencies');
    const tooltipCurrencies = Array.isArray(configuredTooltips)
      ? configuredTooltips.map(String)
      : this.runtime.config.ui.defaultTooltipCurrencies;
    return {
      primaryCurrency,
      currencies: [...new Set([
        primaryCurrency,
        ...tooltipCurrencies
          .map((currency) => currency.toUpperCase())
          .filter((currency) => /^[A-Z]{3}$/.test(currency))
      ])]
    };
  }

  private async currentQuantities() {
    const quantities = new Map<string, Decimal>();
    let incompleteBalanceCount = 0;
    const [addressSelections, addressEventsRows, addressObservations, krakenRows] = await Promise.all([
      this.db.query<{
        address_id: string;
        canonical_asset_id: string;
        history_status: string | null;
      }>({
        sql: `
          SELECT selection.address_id, selection.canonical_asset_id,
                 address_sync_state.status AS history_status
          FROM address_asset_selections AS selection
          JOIN tracked_addresses
            ON tracked_addresses.id = selection.address_id
           AND tracked_addresses.enabled = 1
           AND tracked_addresses.deleted_at_ms IS NULL
          LEFT JOIN address_sync_state
            ON address_sync_state.address_id = selection.address_id
          WHERE selection.enabled = 1
          ORDER BY selection.address_id, selection.canonical_asset_id
        `
      }),
      this.db.query<{
        address_id: string;
        canonical_asset_id: string;
        quantity_delta: string;
      }>({
        sql: `
          SELECT events.address_id, events.canonical_asset_id,
                 events.quantity_delta
          FROM address_balance_events AS events
          JOIN tracked_addresses
            ON tracked_addresses.id = events.address_id
           AND tracked_addresses.enabled = 1
           AND tracked_addresses.deleted_at_ms IS NULL
          JOIN address_asset_selections AS selection
            ON selection.address_id = events.address_id
           AND selection.canonical_asset_id = events.canonical_asset_id
           AND selection.enabled = 1
          WHERE events.finalized = 1
          ORDER BY events.address_id, events.canonical_asset_id,
                   events.occurred_at_ms, events.ordering_key, events.id
        `
      }),
      this.db.query<{
        address_id: string;
        canonical_asset_id: string;
        quantity: string;
      }>({
        sql: `
          SELECT point.address_id, point.canonical_asset_id, point.quantity
          FROM address_balance_points AS point
          JOIN (
            SELECT address_id, canonical_asset_id, MAX(bucket_start_ms) AS newest
            FROM address_balance_points
            WHERE granularity_seconds = 0
            GROUP BY address_id, canonical_asset_id
          ) AS latest
            ON latest.address_id = point.address_id
           AND latest.canonical_asset_id = point.canonical_asset_id
           AND latest.newest = point.bucket_start_ms
          JOIN tracked_addresses
            ON tracked_addresses.id = point.address_id
           AND tracked_addresses.enabled = 1
           AND tracked_addresses.deleted_at_ms IS NULL
          JOIN address_asset_selections AS selection
            ON selection.address_id = point.address_id
           AND selection.canonical_asset_id = point.canonical_asset_id
           AND selection.enabled = 1
          WHERE point.granularity_seconds = 0
        `
      }),
      this.db.query<{
        asset_raw: string;
        canonical_asset_id: string | null;
        quantity: string;
      }>({
        sql: `
          SELECT balance.asset_raw, balance.canonical_asset_id, balance.quantity
          FROM kraken_snapshot_balances AS balance
          WHERE balance.snapshot_id = (
            SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1
          )
        `
      })
    ]);
    const addressEventQuantities = new Map<string, Decimal>();
    for (const row of addressEventsRows) {
      const key = `${row.address_id}:${row.canonical_asset_id}`;
      addressEventQuantities.set(
        key,
        (addressEventQuantities.get(key) ?? new Decimal(0)).plus(row.quantity_delta)
      );
    }
    const addressObservedQuantities = new Map(addressObservations.map((row) => [
      `${row.address_id}:${row.canonical_asset_id}`,
      row.quantity
    ]));
    for (const selection of addressSelections) {
      const key = `${selection.address_id}:${selection.canonical_asset_id}`;
      const observed = addressObservedQuantities.get(key);
      const reconstructed = addressEventQuantities.get(key)?.toString();
      const quantity = observed
        ?? (selection.history_status === 'complete' ? reconstructed ?? '0' : null);
      if (quantity === null) {
        incompleteBalanceCount += 1;
        continue;
      }
      addQuantity({
        quantities,
        assetId: selection.canonical_asset_id,
        quantity
      });
    }
    for (const row of krakenRows) {
      addQuantity({
        quantities,
        assetId: row.canonical_asset_id ?? canonicalKrakenAsset({ raw: row.asset_raw }),
        quantity: row.quantity
      });
    }
    return {
      quantities,
      incompleteBalanceCount,
      addressCount: new Set(addressSelections.map((selection) => selection.address_id)).size,
      krakenAssetRowCount: krakenRows.length
    };
  }

  async capture() {
    const capturedAtMs = Date.now();
    const bucketMs = 30 * 60_000;
    const bucketStartMs = Math.floor(capturedAtMs / bucketMs) * bucketMs;
    const [{ quantities, incompleteBalanceCount, addressCount, krakenAssetRowCount }, currencyConfig] = await Promise.all([
      this.currentQuantities(),
      this.configuredCurrencies()
    ]);
    const assetIds = [...quantities.keys()];
    const lookups = new Map(await Promise.all(currencyConfig.currencies.map(async (currency) => [
      currency,
      await historicalPriceLookup({
        db: this.db,
        assetIds,
        quoteCurrency: currency,
        fromMs: bucketStartMs,
        toMs: capturedAtMs,
        disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
      })
    ] as const)));
    let pricedAssets = 0;
    const values = Object.fromEntries(currencyConfig.currencies.map((currency) => {
      let total = new Decimal(0);
      let currencyPricedAssets = 0;
      for (const [assetId, quantity] of quantities) {
        if (quantity.isZero()) continue;
        const price = assetId === currency.toLowerCase()
          ? '1'
          : lookups.get(currency)!({ assetId, timestampMs: capturedAtMs });
        if (price === null) continue;
        total = total.plus(quantity.times(price));
        currencyPricedAssets += 1;
      }
      if (currency === currencyConfig.primaryCurrency) pricedAssets = currencyPricedAssets;
      return [currency, total.toString()];
    }));
    const nonZeroAssetCount = [...quantities.values()].filter((quantity) => !quantity.isZero()).length;
    const coverage = nonZeroAssetCount + incompleteBalanceCount === 0
      ? new Decimal(100)
      : new Decimal(pricedAssets)
        .dividedBy(nonZeroAssetCount + incompleteBalanceCount)
        .times(100);
    const serializedQuantities = Object.fromEntries(
      [...quantities.entries()].map(([assetId, quantity]) => [assetId, quantity.toString()])
    );
    const id = createId({ prefix: 'portfolio' });
    await this.db.run({
      sql: `
        INSERT INTO portfolio_snapshots(
          id, captured_at_ms, primary_currency, values_json, quantities_json,
          priced_coverage_percent, incomplete_balance_count, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(captured_at_ms)
        DO UPDATE SET
          primary_currency = excluded.primary_currency,
          values_json = excluded.values_json,
          quantities_json = excluded.quantities_json,
          priced_coverage_percent = excluded.priced_coverage_percent,
          incomplete_balance_count = excluded.incomplete_balance_count,
          provenance_json = excluded.provenance_json
      `,
      parameters: [
        id,
        bucketStartMs,
        currencyConfig.primaryCurrency,
        JSON.stringify(values),
        JSON.stringify(serializedQuantities),
        coverage.toString(),
        incompleteBalanceCount,
        JSON.stringify({
          source: 'locally-observed-balances',
          backfilled: false,
          addressCount,
          krakenAssetRowCount
        })
      ]
    });
    return {
      capturedAtMs: bucketStartMs,
      values,
      quantities: serializedQuantities,
      coveragePercent: coverage.toString(),
      incompleteBalanceCount
    };
  }

  async series({
    fromMs,
    toMs,
    quoteCurrencies,
    granularitySeconds = 'auto'
  }: {
    fromMs: number;
    toMs: number;
    quoteCurrencies?: string[];
    granularitySeconds?: number | 'auto';
  }) {
    const currencyConfig = await this.configuredCurrencies();
    const currencies = [...new Set([
      currencyConfig.primaryCurrency,
      'USD',
      ...(quoteCurrencies ?? currencyConfig.currencies)
        .map((currency) => currency.toUpperCase())
        .filter((currency) => /^[A-Z]{3}$/.test(currency))
    ])];
    const oldest = fromMs === 0
      ? await this.db.one<{ oldest: number | string | null }>({
          sql: 'SELECT MIN(captured_at_ms) AS oldest FROM portfolio_snapshots'
        })
      : null;
    const effectiveFromMs = fromMs === 0
      ? Number(oldest?.oldest ?? toMs)
      : fromMs;
    const requestedGranularitySeconds = granularitySeconds === 'auto'
      ? resolveAutoGranularity({ fromMs: effectiveFromMs, toMs })
      : granularitySeconds;
    const sourceGranularitySeconds = 1_800;
    const resolvedGranularitySeconds = boundedOverviewGranularity({
      requestedGranularity: Math.max(
        sourceGranularitySeconds,
        requestedGranularitySeconds
      ),
      fromMs: effectiveFromMs,
      toMs,
      seriesCount: 1
    });
    const bucketMs = resolvedGranularitySeconds * 1_000;
    const snapshots = await this.db.query<PortfolioSnapshotRow>({
      sql: `
        WITH ranked_snapshots AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY CAST(captured_at_ms / ? AS INTEGER)
                   ORDER BY captured_at_ms DESC
                 ) AS bucket_rank
          FROM portfolio_snapshots
          WHERE captured_at_ms >= ? AND captured_at_ms <= ?
        )
        SELECT id, captured_at_ms, primary_currency, values_json,
               quantities_json, priced_coverage_percent,
               incomplete_balance_count, provenance_json
        FROM ranked_snapshots
        WHERE bucket_rank = 1
        ORDER BY captured_at_ms
      `,
      parameters: [bucketMs, effectiveFromMs, toMs]
    });
    const denominationOptions = await enabledChartDenominations({ db: this.db });
    const allAssetIds = [...new Set(snapshots.flatMap((snapshot) => (
      Object.keys(parseRecord(snapshot.quantities_json))
    )))];
    const priceAssetIds = [...new Set([
      ...allAssetIds,
      ...denominationOptions.map((option) => option.id)
    ])];
    const lookups = await historicalPriceLookups({
      db: this.db,
      assetIds: priceAssetIds,
      quoteCurrencies: currencies,
      fromMs: effectiveFromMs,
      toMs,
      queryGranularitySeconds: resolvedGranularitySeconds,
      disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
    });
    const points = snapshots.map((snapshot) => {
      const timestampMs = Number(snapshot.captured_at_ms);
      const quantities = parseRecord(snapshot.quantities_json);
      const storedValues = parseRecord(snapshot.values_json);
      const quotes = Object.fromEntries(currencies.map((currency) => {
        let total = new Decimal(0);
        let priced = 0;
        let expected = 0;
        for (const [assetId, quantityValue] of Object.entries(quantities)) {
          const quantity = new Decimal(quantityValue);
          if (quantity.isZero()) continue;
          expected += 1;
          const price = assetId === currency.toLowerCase()
            ? '1'
            : lookups.get(currency)!({ assetId, timestampMs });
          if (price === null) continue;
          priced += 1;
          total = total.plus(quantity.times(price));
        }
        return [
          currency,
          priced === expected && Number(snapshot.incomplete_balance_count) === 0
            ? total.toString()
            : storedValues[currency] ?? (priced > 0 ? total.toString() : null)
        ];
      }));
      const value = quotes[currencyConfig.primaryCurrency] ?? null;
      const denominationValues = chartDenominationsAt({
        denominationOptions,
        quoteValues: quotes,
        primaryCurrency: currencyConfig.primaryCurrency,
        timestampMs,
        priceAt: ({ assetId, quoteCurrency, timestampMs: priceTimestampMs }) => (
          lookups.get(quoteCurrency)?.({
            assetId,
            timestampMs: priceTimestampMs
          }) ?? null
        )
      });
      return {
        timestampMs,
        value,
        quotes,
        quantities,
        coveragePercent: snapshot.priced_coverage_percent,
        ...denominationValues
      };
    });
    const firstVisiblePointIndex = points.findIndex((point) => (
      point.value === null || !new Decimal(point.value).isZero()
    ));
    const visiblePoints = firstVisiblePointIndex === -1
      ? []
      : points.slice(firstVisiblePointIndex);
    const addressIds = (await this.db.query<{ id: string }>({
      sql: `
        SELECT id FROM tracked_addresses
        WHERE enabled = 1 AND deleted_at_ms IS NULL
        ORDER BY id
      `
    })).map((row) => row.id);
    const [chainEvents, exchangeEvents] = await Promise.all([
      addressEvents({
        db: this.db,
        addressIds,
        fromMs: effectiveFromMs,
        toMs
      }),
      krakenEvents({
        db: this.db,
        fromMs: effectiveFromMs,
        toMs
      })
    ]);
    return {
      quoteCurrency: currencyConfig.primaryCurrency,
      range: {
        from: new Date(effectiveFromMs).toISOString(),
        to: new Date(toMs).toISOString()
      },
      requestedGranularitySeconds,
      granularitySeconds: resolvedGranularitySeconds,
      overviewGranularity: resolvedGranularitySeconds,
      mixedGranularity: resolvedGranularitySeconds > requestedGranularitySeconds,
      denominationOptions,
      events: [...chainEvents, ...exchangeEvents]
        .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id)),
      partial: snapshots.some((snapshot) => (
        new Decimal(snapshot.priced_coverage_percent).lessThan(100)
        || Number(snapshot.incomplete_balance_count) > 0
      )),
      stale: snapshots.length > 0
        && Number(snapshots.at(-1)!.captured_at_ms) < Date.now() - this.runtime.config.sync.staleAfterMinutes * 60_000,
      backfilled: false,
      series: [{
        id: 'combined-portfolio',
        label: 'Combined portfolio',
        points: visiblePoints
      }]
    };
  }
}

export const portfolioServiceInternals = {
  parseRecord
};
