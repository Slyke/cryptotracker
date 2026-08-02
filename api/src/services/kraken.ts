import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase, DatabaseExecutor } from '../db/index.js';
import { calculateCostBasis, type BasisEvent, type CostBasisMethod } from '../domain/cost-basis.js';
import {
  boundedOverviewGranularity,
  resolveAutoGranularity
} from '../domain/graphs.js';
import {
  canonicalKrakenAsset,
  krakenAssetCategory
} from '../domain/kraken-assets.js';
import { combinePriceObservations } from '../domain/market.js';
import { AppError } from '../errors.js';
import type { JobQueue } from '../jobs/queue.js';
import type { KrakenReadOnlyClient } from '../providers/kraken.js';
import { createId } from '../utils/ids.js';
import {
  chartDenominationsAt,
  enabledChartDenominations
} from './chart-values.js';
import { krakenEvents } from './event-markers.js';

export interface KrakenPermissionInspection {
  available: boolean;
  permissions: string[];
  required: string[];
  missing: string[];
  safe: boolean | null;
  unsafe: string[];
  reason?: string;
}

export interface KrakenClientContract {
  isConfigured(): boolean;
  inspectPermissions(): Promise<KrakenPermissionInspection>;
  privateQuery<T>({
    path,
    parameters
  }: {
    path: string;
    parameters?: Record<string, string | number>;
  }): Promise<T>;
  status(): Record<string, unknown>;
}

const nestedValue = ({
  value,
  path
}: {
  value: Record<string, unknown>;
  path: string[];
}) => {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const firstString = (...values: unknown[]) => {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null);
  return value === undefined ? null : String(value);
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)])
  );
};

const serializeCanonicalJson = ({ value }: { value: unknown }) =>
  JSON.stringify(canonicalJsonValue(value)) ?? 'null';

const krakenTimeMs = ({ value }: { value: unknown }) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1_000)
    : null;
};

const projectedApyPercent = ({
  aprPercent,
  autoCompound,
  payoutFrequencySeconds
}: {
  aprPercent: string;
  autoCompound: boolean;
  payoutFrequencySeconds: number | null;
}) => {
  const apr = new Decimal(aprPercent);
  if (!autoCompound || payoutFrequencySeconds === null || payoutFrequencySeconds <= 0) {
    return apr.toString();
  }
  const compoundsPerYear = Math.max(1, Math.floor(365 * 24 * 60 * 60 / payoutFrequencySeconds));
  return new Decimal(1)
    .plus(apr.dividedBy(100).dividedBy(compoundsPerYear))
    .pow(compoundsPerYear)
    .minus(1)
    .times(100)
    .toString();
};

const parsePairAssets = ({ pair }: { pair: string }) => {
  const normalized = pair.toUpperCase();
  const quoteCandidates = ['ZCAD', 'CAD', 'ZAUD', 'AUD', 'ZUSD', 'USD', 'ZEUR', 'EUR', 'ZGBP', 'GBP', 'ZJPY', 'JPY', 'ZCHF', 'CHF', 'XXBT', 'XBT', 'XETH', 'ETH'];
  const quote = quoteCandidates.find((candidate) => normalized.endsWith(candidate)) ?? '';
  const base = quote ? normalized.slice(0, -quote.length) : normalized;
  return {
    baseAssetId: canonicalKrakenAsset({ raw: base }),
    quoteAssetId: canonicalKrakenAsset({ raw: quote })
  };
};

export class KrakenService {
  private permissionState: KrakenPermissionInspection | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly client: KrakenClientContract,
    private readonly jobs: JobQueue
  ) {}

  async initialize() {
    if (!this.client.isConfigured()) return;
    this.permissionState = await this.client.inspectPermissions();
    if (this.permissionState.available && this.permissionState.safe === false) {
      throw new AppError({
        errorKey: 'KRAKEN_PERMISSION_UNSAFE',
        reason: 'Kraken integration was not activated because the API key has permissions outside the query-only allowlist.',
        status: 503,
        context: {
          unsafePermissions: this.permissionState.unsafe
        }
      });
    }
    await this.queueRefresh({ reason: 'startup', priority: 20 });
  }

  async queueRefresh({
    reason = 'manual',
    priority = 10
  }: {
    reason?: string;
    priority?: number;
  } = {}) {
    if (!this.client.isConfigured()) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Kraken credentials are not configured.',
        status: 404
      });
    }
    return this.jobs.enqueue({
      jobType: 'kraken.sync',
      resourceKey: 'kraken:account',
      idempotencyKey: `kraken:${reason}:${Math.floor(Date.now() / (reason === 'scheduled' ? 30 * 60_000 : 60_000))}`,
      priority,
      payload: { reason }
    });
  }

  registerJobs() {
    this.jobs.register({
      jobType: 'kraken.sync',
      handler: async ({ updateProgress }) => {
        if (this.permissionState?.available && this.permissionState.safe === false) {
          throw new AppError({
            errorKey: 'KRAKEN_PERMISSION_UNSAFE',
            reason: 'Permissions outside the Kraken query-only allowlist prevent synchronization.'
          });
        }
        const endpoints = [
          'trades',
          'ledgers',
          'balances',
          'earn',
          'margin',
          'orders',
          'trade-balance',
          'funding',
          'trade-volume',
          'credit-lines'
        ] as const;
        const captureGraphChanges = typeof this.jobs.shouldCaptureGraphDataChanges === 'function'
          ? await this.jobs.shouldCaptureGraphDataChanges()
          : false;
        const graphFingerprintBefore = captureGraphChanges
          ? await this.graphActivityFingerprint()
          : null;
        await updateProgress({ current: 0, total: endpoints.length });
        await this.syncTrades();
        await updateProgress({ current: 1, total: endpoints.length, cursor: { endpoint: 'trades' } });
        await this.syncLedgers();
        await updateProgress({ current: 2, total: endpoints.length, cursor: { endpoint: 'ledgers' } });
        const balances = await this.syncExtendedBalances();
        await updateProgress({ current: 3, total: endpoints.length, cursor: { endpoint: 'balances' } });
        await this.syncEarn();
        await updateProgress({ current: 4, total: endpoints.length, cursor: { endpoint: 'earn' } });
        await this.syncMargin();
        await updateProgress({ current: 5, total: endpoints.length, cursor: { endpoint: 'margin' } });
        await this.syncOrders();
        await updateProgress({ current: 6, total: endpoints.length, cursor: { endpoint: 'orders' } });
        await this.syncTradeBalance();
        await updateProgress({ current: 7, total: endpoints.length, cursor: { endpoint: 'trade-balance' } });
        await this.syncFunding();
        await updateProgress({ current: 8, total: endpoints.length, cursor: { endpoint: 'funding' } });
        await this.syncTradeVolume();
        await updateProgress({ current: 9, total: endpoints.length, cursor: { endpoint: 'trade-volume' } });
        await this.syncCreditLines();
        const snapshot = await this.writeSnapshot({
          balances,
          detectChanges: captureGraphChanges
        });
        await updateProgress({ current: 10, total: endpoints.length, cursor: { endpoint: 'complete' } });
        await this.jobs.enqueue({
          jobType: 'transfers.reconcile',
          resourceKey: 'owned-transfers',
          idempotencyKey: `transfers:kraken:${Math.floor(Date.now() / 60_000)}`,
          priority: 30,
          payload: { reason: 'kraken-sync' }
        });
        const graphChanged = snapshot.changed
          || (
            graphFingerprintBefore !== null
            && graphFingerprintBefore !== await this.graphActivityFingerprint()
          );
        return graphChanged
          ? {
              graphDataChanges: [{
                domain: 'kraken' as const,
                assetIds: snapshot.assetIds
              }]
            }
          : undefined;
      }
    });
  }

  private async graphActivityFingerprint() {
    const [trades, ledgers, allocations, rates] = await Promise.all([
      this.db.query<Record<string, string | number | null>>({
        sql: `
          SELECT kraken_id, asset_in_id, asset_out_id, pair_raw, side,
                 occurred_at_ms, quantity, price, cost, fee
          FROM kraken_trades
          ORDER BY occurred_at_ms, kraken_id
        `
      }),
      this.db.query<Record<string, string | number | null>>({
        sql: `
          SELECT kraken_id, asset_raw, canonical_asset_id, event_type, subtype,
                 occurred_at_ms, amount, fee, transaction_id
          FROM kraken_ledgers
          ORDER BY occurred_at_ms, kraken_id
        `
      }),
      this.db.query<Record<string, string | number | null>>({
        sql: `
          SELECT allocation_id, asset_raw, canonical_asset_id, product_id,
                 quantity, reward_quantity, state
          FROM kraken_earn_allocations
          ORDER BY allocation_id
        `
      }),
      this.db.query<Record<string, string | number | null>>({
        sql: `
          SELECT strategy_id, asset_raw, canonical_asset_id, captured_at_ms,
                 apy_low_percent, apy_high_percent
          FROM kraken_earn_strategy_rates
          ORDER BY captured_at_ms, strategy_id
        `
      })
    ]);
    return createHash('sha256')
      .update(serializeCanonicalJson({ value: { trades, ledgers, allocations, rates } }))
      .digest('hex');
  }

  private async recordObservation({
    executor = this.db,
    endpoint,
    entityId,
    observedAtMs,
    sourceAtMs = null,
    present = true,
    payload
  }: {
    executor?: DatabaseExecutor;
    endpoint: string;
    entityId: string;
    observedAtMs: number;
    sourceAtMs?: number | null;
    present?: boolean;
    payload: unknown;
  }) {
    const rawJson = serializeCanonicalJson({ value: payload });
    const payloadHash = createHash('sha256').update(rawJson).digest('hex');
    const latest = await executor.one<{
      id: string;
      payload_hash: string;
      present: number | string;
    }>({
      sql: `
        SELECT id, payload_hash, present
        FROM kraken_account_observations
        WHERE endpoint = ? AND entity_id = ?
        ORDER BY observed_at_ms DESC
        LIMIT 1
      `,
      parameters: [endpoint, entityId]
    });
    if (
      latest
      && latest.payload_hash === payloadHash
      && Boolean(Number(latest.present)) === present
    ) {
      await executor.run({
        sql: `
          UPDATE kraken_account_observations
          SET last_seen_at_ms = CASE
            WHEN last_seen_at_ms < ? THEN ? ELSE last_seen_at_ms
          END
          WHERE id = ?
        `,
        parameters: [observedAtMs, observedAtMs, latest.id]
      });
      return { inserted: false, rawBytes: 0 };
    }
    await executor.run({
      sql: `
        INSERT INTO kraken_account_observations(
          id, endpoint, entity_id, observed_at_ms, last_seen_at_ms,
          source_at_ms, present, payload_hash, raw_json, raw_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint, entity_id, observed_at_ms) DO UPDATE SET
          last_seen_at_ms = excluded.last_seen_at_ms,
          source_at_ms = excluded.source_at_ms,
          present = excluded.present,
          payload_hash = excluded.payload_hash,
          raw_json = excluded.raw_json,
          raw_bytes = excluded.raw_bytes
      `,
      parameters: [
        createId({ prefix: 'kao' }),
        endpoint,
        entityId,
        observedAtMs,
        observedAtMs,
        sourceAtMs,
        present ? 1 : 0,
        payloadHash,
        rawJson,
        Buffer.byteLength(rawJson)
      ]
    });
    return { inserted: true, rawBytes: Buffer.byteLength(rawJson) };
  }

  private async markMissingObservations({
    executor = this.db,
    endpoint,
    presentEntityIds,
    observedAtMs
  }: {
    executor?: DatabaseExecutor;
    endpoint: string;
    presentEntityIds: Set<string>;
    observedAtMs: number;
  }) {
    const latestPresent = await executor.query<{ entity_id: string }>({
      sql: `
        SELECT observation.entity_id
        FROM kraken_account_observations AS observation
        WHERE observation.endpoint = ?
          AND observation.present = 1
          AND NOT EXISTS (
            SELECT 1
            FROM kraken_account_observations AS newer
            WHERE newer.endpoint = observation.endpoint
              AND newer.entity_id = observation.entity_id
              AND newer.observed_at_ms > observation.observed_at_ms
          )
      `,
      parameters: [endpoint]
    });
    for (const row of latestPresent) {
      if (presentEntityIds.has(row.entity_id)) continue;
      await this.recordObservation({
        executor,
        endpoint,
        entityId: row.entity_id,
        observedAtMs,
        present: false,
        payload: {}
      });
    }
  }

  private async syncExtendedBalances() {
    const observedAtMs = Date.now();
    let extended: Record<string, unknown>;
    let fallback = false;
    try {
      extended = await this.client.privateQuery<Record<string, unknown>>({
        path: '/0/private/BalanceEx'
      });
    } catch (error) {
      fallback = true;
      extended = await this.client.privateQuery<Record<string, string>>({
        path: '/0/private/Balance'
      });
      await this.updateCursor({
        executor: this.db,
        endpoint: 'extended-balances',
        count: Object.keys(extended).length,
        now: observedAtMs,
        completeness: 'partial',
        cursor: { fallback: '/0/private/Balance' },
        error
      });
    }
    const balances: Record<string, string> = {};
    if (fallback) {
      for (const [asset, rawValue] of Object.entries(extended)) {
        balances[asset] = firstString(
          rawValue && typeof rawValue === 'object'
            ? (rawValue as Record<string, unknown>).balance
            : rawValue
        ) ?? '0';
      }
      return balances;
    }
    const presentEntityIds = new Set<string>();
    await this.db.transaction({
      task: async (executor) => {
        for (const [asset, rawValue] of Object.entries(extended)) {
          const detail = rawValue && typeof rawValue === 'object'
            ? rawValue as Record<string, unknown>
            : { balance: rawValue };
          const balance = firstString(detail.balance) ?? '0';
          balances[asset] = balance;
          presentEntityIds.add(asset);
          await this.recordObservation({
            executor,
            endpoint: 'extended-balances',
            entityId: asset,
            observedAtMs,
            payload: detail
          });
        }
        await this.markMissingObservations({
          executor,
          endpoint: 'extended-balances',
          presentEntityIds,
          observedAtMs
        });
        await this.updateCursor({
          executor,
          endpoint: 'extended-balances',
          count: presentEntityIds.size,
          now: observedAtMs,
          completeness: 'complete'
        });
      }
    });
    return balances;
  }

  private async cursorState({ endpoint }: { endpoint: string }) {
    const row = await this.db.one<{
      cursor_json: string;
      completeness: string;
      oldest_at_ms: number | string | null;
      newest_at_ms: number | string | null;
    }>({
      sql: 'SELECT cursor_json, completeness, oldest_at_ms, newest_at_ms FROM kraken_sync_cursors WHERE endpoint = ?',
      parameters: [endpoint]
    });
    let cursor: Record<string, unknown> = {};
    try {
      cursor = JSON.parse(row?.cursor_json ?? '{}') as Record<string, unknown>;
    } catch {
      cursor = {};
    }
    return {
      cursor,
      completeness: row?.completeness ?? 'syncing',
      oldestAtMs: row?.oldest_at_ms === null || row?.oldest_at_ms === undefined
        ? null
        : Number(row.oldest_at_ms),
      newestAtMs: row?.newest_at_ms === null || row?.newest_at_ms === undefined
        ? null
        : Number(row.newest_at_ms)
    };
  }

  private async syncTrades() {
    const previous = await this.cursorState({ endpoint: 'trades' });
    const resumed = previous.completeness === 'syncing';
    let offset = resumed ? Number(previous.cursor.offset ?? 0) : 0;
    const startSeconds = resumed
      ? Number(previous.cursor.startSeconds ?? 0) || null
      : previous.newestAtMs === null
        ? null
        : Math.max(0, Math.floor((previous.newestAtMs - 60 * 60_000) / 1_000));
    let page = 0;
    while (page < 10_000) {
      const result = await this.client.privateQuery<{
        trades?: Record<string, Record<string, string>>;
        count?: number;
      }>({
        path: '/0/private/TradesHistory',
        parameters: {
          type: 'all',
          trades: 'true',
          ofs: offset,
          ...(startSeconds === null ? {} : { start: startSeconds })
        }
      });
      const entries = Object.entries(result.trades ?? {});
      const total = Number(result.count ?? offset + entries.length);
      const nextOffset = offset + entries.length;
      const complete = entries.length === 0 || nextOffset >= total;
      const times = entries.map(([, trade]) => Math.round(Number(trade.time ?? 0) * 1_000));
      const now = Date.now();
      await this.db.transaction({
        task: async (executor) => {
          for (const [krakenId, trade] of entries) {
            const assets = parsePairAssets({ pair: trade.pair ?? '' });
            await executor.run({
              sql: `
                INSERT INTO kraken_trades(
                  id, kraken_id, order_id, asset_in_id, asset_out_id, pair_raw,
                  side, occurred_at_ms, quantity, price, cost, fee, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kraken_id) DO UPDATE SET
                  order_id = excluded.order_id,
                  quantity = excluded.quantity,
                  price = excluded.price,
                  cost = excluded.cost,
                  fee = excluded.fee,
                  raw_json = excluded.raw_json
              `,
              parameters: [
                createId({ prefix: 'ktr' }),
                krakenId,
                trade.ordertxid ?? null,
                trade.type === 'buy' ? assets.baseAssetId : assets.quoteAssetId,
                trade.type === 'buy' ? assets.quoteAssetId : assets.baseAssetId,
                trade.pair ?? '',
                trade.type ?? '',
                Math.round(Number(trade.time ?? 0) * 1_000),
                trade.vol ?? '0',
                trade.price ?? '0',
                trade.cost ?? null,
                trade.fee ?? null,
                JSON.stringify(trade)
              ]
            });
            if (trade.postxid || trade.posstatus || new Decimal(trade.margin ?? '0').greaterThan(0)) {
              const positionId = trade.postxid ?? `${trade.ordertxid ?? 'trade'}:${krakenId}`;
              const status = trade.posstatus ?? 'closed';
              const occurredAtMs = Math.round(Number(trade.time ?? 0) * 1_000);
              await executor.run({
                sql: `
                  INSERT INTO kraken_margin_positions(
                    id, kraken_id, status, pair_raw, opened_at_ms, closed_at_ms,
                    volume, cost, fee, realised_pnl, unrealised_pnl, raw_json, updated_at_ms
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                  ON CONFLICT(kraken_id) DO UPDATE SET
                    status = excluded.status,
                    closed_at_ms = COALESCE(excluded.closed_at_ms, kraken_margin_positions.closed_at_ms),
                    volume = excluded.volume,
                    cost = excluded.cost,
                    fee = excluded.fee,
                    realised_pnl = excluded.realised_pnl,
                    raw_json = excluded.raw_json,
                    updated_at_ms = excluded.updated_at_ms
                `,
                parameters: [
                  createId({ prefix: 'kmp' }),
                  positionId,
                  status,
                  trade.pair ?? '',
                  occurredAtMs,
                  status === 'closed' ? occurredAtMs : null,
                  trade.vol ?? null,
                  trade.cost ?? null,
                  trade.fee ?? null,
                  trade.net ?? null,
                  JSON.stringify(trade),
                  now
                ]
              });
            }
          }
          await this.updateCursor({
            executor,
            endpoint: 'trades',
            count: nextOffset,
            cursor: {
              offset: complete ? 0 : nextOffset,
              startSeconds,
              providerCount: total
            },
            completeness: complete ? 'complete' : 'syncing',
            oldestAtMs: times.length === 0 ? previous.oldestAtMs : Math.min(...times),
            newestAtMs: times.length === 0 ? previous.newestAtMs : Math.max(...times),
            now
          });
        }
      });
      if (complete) return;
      offset = nextOffset;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken trade history exceeded the pagination safety boundary.'
    });
  }

  private async syncLedgers() {
    const previous = await this.cursorState({ endpoint: 'ledgers' });
    const resumed = previous.completeness === 'syncing';
    let offset = resumed ? Number(previous.cursor.offset ?? 0) : 0;
    const startSeconds = resumed
      ? Number(previous.cursor.startSeconds ?? 0) || null
      : previous.newestAtMs === null
        ? null
        : Math.max(0, Math.floor((previous.newestAtMs - 60 * 60_000) / 1_000));
    let page = 0;
    while (page < 10_000) {
      const result = await this.client.privateQuery<{
        ledger?: Record<string, Record<string, string>>;
        count?: number;
      }>({
        path: '/0/private/Ledgers',
        parameters: {
          type: 'all',
          ofs: offset,
          ...(startSeconds === null ? {} : { start: startSeconds })
        }
      });
      const entries = Object.entries(result.ledger ?? {});
      const total = Number(result.count ?? offset + entries.length);
      const nextOffset = offset + entries.length;
      const complete = entries.length === 0 || nextOffset >= total;
      const times = entries.map(([, ledger]) => Math.round(Number(ledger.time ?? 0) * 1_000));
      const now = Date.now();
      await this.db.transaction({
        task: async (executor) => {
          for (const [krakenId, ledger] of entries) {
            await executor.run({
              sql: `
                INSERT INTO kraken_ledgers(
                  id, kraken_id, reference_id, asset_raw, canonical_asset_id, event_type,
                  subtype, occurred_at_ms, amount, fee, transaction_id, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kraken_id) DO UPDATE SET
                  amount = excluded.amount,
                  fee = excluded.fee,
                  raw_json = excluded.raw_json
              `,
              parameters: [
                createId({ prefix: 'kle' }),
                krakenId,
                ledger.refid ?? null,
                ledger.asset ?? '',
                canonicalKrakenAsset({ raw: ledger.asset ?? '' }),
                ledger.type ?? '',
                ledger.subtype ?? null,
                Math.round(Number(ledger.time ?? 0) * 1_000),
                ledger.amount ?? '0',
                ledger.fee ?? null,
                ledger.txid ?? ledger.refid ?? null,
                JSON.stringify(ledger)
              ]
            });
          }
          await this.updateCursor({
            executor,
            endpoint: 'ledgers',
            count: nextOffset,
            cursor: {
              offset: complete ? 0 : nextOffset,
              startSeconds,
              providerCount: total
            },
            completeness: complete ? 'complete' : 'syncing',
            oldestAtMs: times.length === 0 ? previous.oldestAtMs : Math.min(...times),
            newestAtMs: times.length === 0 ? previous.newestAtMs : Math.max(...times),
            now
          });
        }
      });
      if (complete) return;
      offset = nextOffset;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken ledger history exceeded the pagination safety boundary.'
    });
  }

  private async syncEarn() {
    const strategyIds = await this.syncEarnAllocations();
    await this.syncEarnStrategies();
    await this.syncEarnOperationStatuses({ strategyIds });
  }

  private async syncEarnAllocations() {
    const previous = await this.cursorState({ endpoint: 'earn' });
    const observedAtMs = Date.now();
    const observedStrategyIds = new Set<string>();
    let recordedSummary = false;
    let nextCursor = previous.completeness === 'syncing'
      ? typeof previous.cursor.nextCursor === 'string' ? previous.cursor.nextCursor : null
      : null;
    const startedAtBeginning = nextCursor === null;
    let count = previous.completeness === 'syncing' ? Number(previous.cursor.count ?? 0) : 0;
    let page = 0;
    while (page < 10_000) {
      let result: Record<string, unknown>;
      try {
        result = await this.client.privateQuery<Record<string, unknown>>({
          path: '/0/private/Earn/Allocations',
          parameters: nextCursor ? { cursor: nextCursor } : {}
        });
      } catch (error) {
        await this.updateCursor({
          executor: this.db,
          endpoint: 'earn',
          count,
          now: Date.now(),
          completeness: 'partial',
          cursor: { nextCursor },
          error
        });
        return observedStrategyIds;
      }
      const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : [];
      const providerNextCursor = typeof result.next_cursor === 'string' && result.next_cursor.length > 0
        ? result.next_cursor
        : null;
      const complete = providerNextCursor === null || providerNextCursor === nextCursor;
      const now = Date.now();
      count += items.length;
      await this.db.transaction({
        task: async (executor) => {
          for (const item of items) {
            const assetRaw = firstString(item.native_asset, item.asset) ?? '';
            const quantity = firstString(
              nestedValue({ value: item, path: ['amount_allocated', 'total', 'native'] }),
              item.amount,
              item.quantity
            ) ?? '0';
            const rewarded = firstString(
              nestedValue({ value: item, path: ['total_rewarded', 'native'] }),
              nestedValue({ value: item, path: ['total_rewarded', 'total', 'native'] }),
              item.rewards
            );
            const allocationId = String(
              item.id
              ?? item.strategy_id
              ?? `${assetRaw}:${String(item.status ?? 'active')}`
            );
            observedStrategyIds.add(allocationId);
            await this.recordObservation({
              executor,
              endpoint: 'earn-allocations',
              entityId: allocationId,
              observedAtMs,
              payload: item
            });
            await executor.run({
              sql: `
                INSERT INTO kraken_earn_allocations(
                  id, allocation_id, asset_raw, canonical_asset_id, product_id,
                  quantity, reward_quantity, state, captured_at_ms, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(allocation_id) DO UPDATE SET
                  asset_raw = excluded.asset_raw,
                  canonical_asset_id = excluded.canonical_asset_id,
                  product_id = excluded.product_id,
                  quantity = excluded.quantity,
                  reward_quantity = excluded.reward_quantity,
                  state = excluded.state,
                  captured_at_ms = excluded.captured_at_ms,
                  raw_json = excluded.raw_json
              `,
              parameters: [
                createId({ prefix: 'kea' }),
                allocationId,
                assetRaw,
                canonicalKrakenAsset({ raw: assetRaw }),
                item.strategy_id ? String(item.strategy_id) : null,
                quantity,
                rewarded,
                String(
                  item.status
                  ?? (item.is_utilized === true ? 'utilized' : 'active')
                ),
                now,
                JSON.stringify(item)
              ]
            });
          }
          if (!recordedSummary && startedAtBeginning) {
            const { items: _items, next_cursor: _nextCursor, ...summary } = result;
            await this.recordObservation({
              executor,
              endpoint: 'earn-allocations',
              entityId: 'account-summary',
              observedAtMs,
              payload: summary
            });
            recordedSummary = true;
          }
          if (complete && startedAtBeginning) {
            await this.markMissingObservations({
              executor,
              endpoint: 'earn-allocations',
              presentEntityIds: new Set([
                'account-summary',
                ...observedStrategyIds
              ]),
              observedAtMs
            });
          }
          await this.updateCursor({
            executor,
            endpoint: 'earn',
            count,
            now,
            completeness: complete ? 'complete' : 'syncing',
            cursor: { nextCursor: complete ? null : providerNextCursor }
          });
        }
      });
      if (complete) return observedStrategyIds;
      nextCursor = providerNextCursor;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken Earn allocations exceeded the pagination safety boundary.'
    });
  }

  private async syncEarnOperationStatuses({
    strategyIds
  }: {
    strategyIds: Set<string>;
  }) {
    const observedAtMs = Date.now();
    let count = 0;
    const warnings: string[] = [];
    for (const strategyId of strategyIds) {
      for (const operation of ['allocate', 'deallocate'] as const) {
        const path = operation === 'allocate'
          ? '/0/private/Earn/AllocateStatus'
          : '/0/private/Earn/DeallocateStatus';
        try {
          const result = await this.client.privateQuery<Record<string, unknown>>({
            path,
            parameters: { strategy_id: strategyId }
          });
          await this.recordObservation({
            endpoint: 'earn-operation-status',
            entityId: `${strategyId}:${operation}`,
            observedAtMs,
            payload: result
          });
          count += 1;
        } catch (error) {
          warnings.push(
            `${operation}:${strategyId}:${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
    await this.updateCursor({
      executor: this.db,
      endpoint: 'earn-operation-status',
      count,
      now: observedAtMs,
      completeness: warnings.length === 0 ? 'complete' : 'partial',
      cursor: warnings.length === 0 ? {} : { warnings }
    });
  }

  private async syncEarnStrategies() {
    let nextCursor: string | null = null;
    let count = 0;
    let page = 0;
    while (page < 10_000) {
      let result: Record<string, unknown>;
      try {
        result = await this.client.privateQuery<Record<string, unknown>>({
          path: '/0/private/Earn/Strategies',
          parameters: nextCursor ? { cursor: nextCursor } : {}
        });
      } catch (error) {
        await this.updateCursor({
          executor: this.db,
          endpoint: 'earn-strategies',
          count,
          now: Date.now(),
          completeness: 'partial',
          cursor: { nextCursor },
          error
        });
        return;
      }
      const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : [];
      const providerNextCursor = typeof result.next_cursor === 'string' && result.next_cursor.length > 0
        ? result.next_cursor
        : null;
      const complete = providerNextCursor === null || providerNextCursor === nextCursor;
      const capturedAtMs = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000);
      count += items.length;
      await this.db.transaction({
        task: async (executor) => {
          for (const item of items) {
            const strategyId = firstString(item.id, item.strategy_id);
            const assetRaw = firstString(item.asset, item.native_asset);
            const aprLow = firstString(
              nestedValue({ value: item, path: ['apr_estimate', 'low'] }),
              item.apr
            );
            const aprHigh = firstString(
              nestedValue({ value: item, path: ['apr_estimate', 'high'] }),
              item.apr
            );
            if (!strategyId || !assetRaw || aprLow === null || aprHigh === null) continue;
            const autoCompound = firstString(
              nestedValue({ value: item, path: ['auto_compound', 'type'] })
            ) === 'enabled';
            const payoutFrequency = Number(
              nestedValue({ value: item, path: ['lock_type', 'payout_frequency'] })
            );
            const payoutFrequencySeconds = Number.isFinite(payoutFrequency) && payoutFrequency > 0
              ? Math.floor(payoutFrequency)
              : null;
            await executor.run({
              sql: `
                INSERT INTO kraken_earn_strategy_rates(
                  id, strategy_id, asset_raw, canonical_asset_id, captured_at_ms,
                  apr_low_percent, apr_high_percent, apy_low_percent, apy_high_percent,
                  auto_compound, payout_frequency_seconds, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(strategy_id, captured_at_ms) DO UPDATE SET
                  asset_raw = excluded.asset_raw,
                  canonical_asset_id = excluded.canonical_asset_id,
                  apr_low_percent = excluded.apr_low_percent,
                  apr_high_percent = excluded.apr_high_percent,
                  apy_low_percent = excluded.apy_low_percent,
                  apy_high_percent = excluded.apy_high_percent,
                  auto_compound = excluded.auto_compound,
                  payout_frequency_seconds = excluded.payout_frequency_seconds,
                  raw_json = excluded.raw_json
              `,
              parameters: [
                createId({ prefix: 'ker' }),
                strategyId,
                assetRaw,
                canonicalKrakenAsset({ raw: assetRaw }),
                capturedAtMs,
                aprLow,
                aprHigh,
                projectedApyPercent({
                  aprPercent: aprLow,
                  autoCompound,
                  payoutFrequencySeconds
                }),
                projectedApyPercent({
                  aprPercent: aprHigh,
                  autoCompound,
                  payoutFrequencySeconds
                }),
                autoCompound ? 1 : 0,
                payoutFrequencySeconds,
                JSON.stringify(item)
              ]
            });
          }
          await this.updateCursor({
            executor,
            endpoint: 'earn-strategies',
            count,
            now: Date.now(),
            completeness: complete ? 'complete' : 'syncing',
            cursor: { nextCursor: complete ? null : providerNextCursor },
            oldestAtMs: capturedAtMs,
            newestAtMs: capturedAtMs
          });
        }
      });
      if (complete) return;
      nextCursor = providerNextCursor;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken Earn strategies exceeded the pagination safety boundary.'
    });
  }

  private async syncMargin() {
    const result = await this.client.privateQuery<Record<string, Record<string, string>>>({
      path: '/0/private/OpenPositions',
      parameters: { docalcs: 'true', consolidation: 'market' }
    });
    const now = Date.now();
    const presentEntityIds = new Set(Object.keys(result ?? {}));
    await this.db.transaction({
      task: async (executor) => {
        for (const [krakenId, position] of Object.entries(result ?? {})) {
          await this.recordObservation({
            executor,
            endpoint: 'margin-positions',
            entityId: krakenId,
            observedAtMs: now,
            sourceAtMs: krakenTimeMs({ value: position.time }),
            payload: position
          });
          await executor.run({
            sql: `
              INSERT INTO kraken_margin_positions(
                id, kraken_id, status, pair_raw, opened_at_ms, closed_at_ms,
                volume, cost, fee, realised_pnl, unrealised_pnl, raw_json, updated_at_ms
              ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(kraken_id) DO UPDATE SET
                status = excluded.status,
                volume = excluded.volume,
                cost = excluded.cost,
                fee = excluded.fee,
                realised_pnl = excluded.realised_pnl,
                unrealised_pnl = excluded.unrealised_pnl,
                raw_json = excluded.raw_json,
                updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [
              createId({ prefix: 'kmp' }),
              krakenId,
              position.pair ?? '',
              Math.round(Number(position.time ?? 0) * 1_000),
              position.vol ?? null,
              position.cost ?? null,
              position.fee ?? null,
              position.net ?? null,
              position.value ? new Decimal(position.value).minus(position.cost ?? '0').toString() : null,
              JSON.stringify(position),
              now
            ]
          });
        }
        await this.markMissingObservations({
          executor,
          endpoint: 'margin-positions',
          presentEntityIds,
          observedAtMs: now
        });
        await this.updateCursor({
          executor,
          endpoint: 'margin',
          count: Object.keys(result ?? {}).length,
          now,
          completeness: 'complete'
        });
      }
    });
  }

  private async syncOrders() {
    await this.syncOpenOrders();
    await this.syncClosedOrders();
  }

  private async syncOpenOrders() {
    const now = Date.now();
    try {
      const result = await this.client.privateQuery<{
        open?: Record<string, Record<string, unknown>>;
      }>({
        path: '/0/private/OpenOrders',
        parameters: { trades: 'true' }
      });
      const orders = result.open ?? {};
      const presentEntityIds = new Set(Object.keys(orders));
      await this.db.transaction({
        task: async (executor) => {
          for (const [orderId, order] of Object.entries(orders)) {
            await this.recordObservation({
              executor,
              endpoint: 'open-orders',
              entityId: orderId,
              observedAtMs: now,
              sourceAtMs: krakenTimeMs({ value: order.opentm }),
              payload: order
            });
          }
          await this.markMissingObservations({
            executor,
            endpoint: 'open-orders',
            presentEntityIds,
            observedAtMs: now
          });
          await this.updateCursor({
            executor,
            endpoint: 'open-orders',
            count: presentEntityIds.size,
            now,
            completeness: 'complete'
          });
        }
      });
    } catch (error) {
      await this.updateCursor({
        executor: this.db,
        endpoint: 'open-orders',
        count: 0,
        now,
        completeness: 'partial',
        error
      });
    }
  }

  private async syncClosedOrders() {
    const previous = await this.cursorState({ endpoint: 'closed-orders' });
    const resumed = previous.completeness === 'syncing';
    let offset = resumed ? Number(previous.cursor.offset ?? 0) : 0;
    const startSeconds = resumed
      ? Number(previous.cursor.startSeconds ?? 0) || null
      : previous.newestAtMs === null
        ? null
        : Math.max(0, Math.floor((previous.newestAtMs - 60 * 60_000) / 1_000));
    let page = 0;
    while (page < 10_000) {
      let result: {
        closed?: Record<string, Record<string, unknown>>;
        count?: number;
      };
      try {
        result = await this.client.privateQuery<typeof result>({
          path: '/0/private/ClosedOrders',
          parameters: {
            trades: 'true',
            ofs: offset,
            ...(startSeconds === null ? {} : { start: startSeconds })
          }
        });
      } catch (error) {
        await this.updateCursor({
          executor: this.db,
          endpoint: 'closed-orders',
          count: offset,
          now: Date.now(),
          completeness: offset > 0 || resumed ? 'syncing' : 'partial',
          cursor: { offset, startSeconds },
          error
        });
        return;
      }
      const entries = Object.entries(result.closed ?? {});
      const total = Number(result.count ?? offset + entries.length);
      const nextOffset = offset + entries.length;
      const complete = entries.length === 0 || nextOffset >= total;
      const now = Date.now();
      const times = entries
        .map(([, order]) => krakenTimeMs({ value: order.closetm ?? order.opentm }))
        .filter((value): value is number => value !== null);
      await this.db.transaction({
        task: async (executor) => {
          for (const [orderId, order] of entries) {
            await this.recordObservation({
              executor,
              endpoint: 'closed-orders',
              entityId: orderId,
              observedAtMs: now,
              sourceAtMs: krakenTimeMs({ value: order.closetm ?? order.opentm }),
              payload: order
            });
          }
          await this.updateCursor({
            executor,
            endpoint: 'closed-orders',
            count: nextOffset,
            now,
            completeness: complete ? 'complete' : 'syncing',
            cursor: {
              offset: complete ? 0 : nextOffset,
              startSeconds,
              providerCount: total
            },
            oldestAtMs: times.length === 0 ? previous.oldestAtMs : Math.min(...times),
            newestAtMs: times.length === 0 ? previous.newestAtMs : Math.max(...times)
          });
        }
      });
      if (complete) return;
      offset = nextOffset;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken closed-order history exceeded the pagination safety boundary.'
    });
  }

  private async syncTradeBalance() {
    const now = Date.now();
    const asset = await this.primaryCurrency();
    try {
      const result = await this.client.privateQuery<Record<string, unknown>>({
        path: '/0/private/TradeBalance',
        parameters: { asset }
      });
      await this.db.transaction({
        task: async (executor) => {
          await this.recordObservation({
            executor,
            endpoint: 'trade-balance',
            entityId: asset,
            observedAtMs: now,
            payload: result
          });
          await this.updateCursor({
            executor,
            endpoint: 'trade-balance',
            count: 1,
            now,
            completeness: 'complete'
          });
        }
      });
    } catch (error) {
      await this.updateCursor({
        executor: this.db,
        endpoint: 'trade-balance',
        count: 0,
        now,
        completeness: 'partial',
        cursor: { asset },
        error
      });
    }
  }

  private async syncFunding() {
    await this.syncFundingEndpoint({
      path: '/0/private/DepositStatus',
      endpoint: 'deposit-status',
      collectionKeys: ['deposits', 'items']
    });
    await this.syncFundingEndpoint({
      path: '/0/private/WithdrawStatus',
      endpoint: 'withdraw-status',
      collectionKeys: ['withdrawals', 'items']
    });
  }

  private async syncFundingEndpoint({
    path,
    endpoint,
    collectionKeys
  }: {
    path: '/0/private/DepositStatus' | '/0/private/WithdrawStatus';
    endpoint: 'deposit-status' | 'withdraw-status';
    collectionKeys: string[];
  }) {
    let cursor: string | null = null;
    let count = 0;
    let page = 0;
    while (page < 10_000) {
      let result: unknown;
      try {
        result = await this.client.privateQuery<unknown>({
          path,
          parameters: {
            cursor: cursor ?? 'true',
            limit: 500
          }
        });
      } catch (error) {
        await this.updateCursor({
          executor: this.db,
          endpoint,
          count,
          now: Date.now(),
          completeness: 'partial',
          cursor: { nextCursor: cursor },
          error
        });
        return;
      }
      const container = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      const items = Array.isArray(result)
        ? result as Array<Record<string, unknown>>
        : collectionKeys
            .map((key) => container?.[key])
            .find(Array.isArray) as Array<Record<string, unknown>> | undefined
          ?? [];
      const rawNextCursor = container?.next_cursor ?? container?.cursor;
      const nextCursor = typeof rawNextCursor === 'string' && rawNextCursor.length > 0
        ? rawNextCursor
        : null;
      const complete = Array.isArray(result)
        || !nextCursor
        || nextCursor === cursor
        || items.length === 0;
      const now = Date.now();
      await this.db.transaction({
        task: async (executor) => {
          for (const item of items) {
            const fallbackIdentity = createHash('sha256')
              .update(serializeCanonicalJson({
                value: {
                  time: item.time,
                  asset: item.asset,
                  amount: item.amount,
                  method: item.method,
                  info: item.info
                }
              }))
              .digest('hex')
              .slice(0, 24);
            const entityId = firstString(item.refid, item.txid, item.id) ?? fallbackIdentity;
            await this.recordObservation({
              executor,
              endpoint,
              entityId,
              observedAtMs: now,
              sourceAtMs: krakenTimeMs({ value: item.time }),
              payload: item
            });
          }
          count += items.length;
          await this.updateCursor({
            executor,
            endpoint,
            count,
            now,
            completeness: complete ? 'complete' : 'syncing',
            cursor: { nextCursor: complete ? null : nextCursor }
          });
        }
      });
      if (complete) return;
      cursor = nextCursor;
      page += 1;
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: `Kraken ${endpoint} history exceeded the pagination safety boundary.`
    });
  }

  private async syncTradeVolume() {
    const pairs = (await this.db.query<{ pair_raw: string }>({
      sql: `
        SELECT DISTINCT pair_raw
        FROM kraken_trades
        WHERE pair_raw != ''
        ORDER BY pair_raw
      `
    })).map((row) => row.pair_raw);
    const chunks: string[][] = [];
    for (let index = 0; index < pairs.length; index += 50) {
      chunks.push(pairs.slice(index, index + 50));
    }
    if (chunks.length === 0) chunks.push([]);
    const now = Date.now();
    let count = 0;
    const warnings: string[] = [];
    const presentEntityIds = new Set<string>();
    for (const chunk of chunks) {
      try {
        const result = await this.client.privateQuery<Record<string, unknown>>({
          path: '/0/private/TradeVolume',
          parameters: {
            fee_schedule: 'true',
            ...(chunk.length === 0 ? {} : { pair: chunk.join(',') })
          }
        });
        const entityId = chunk.length === 0
          ? 'account'
          : `pairs:${createHash('sha256').update(chunk.join(',')).digest('hex').slice(0, 16)}`;
        presentEntityIds.add(entityId);
        await this.recordObservation({
          endpoint: 'trade-volume',
          entityId,
          observedAtMs: now,
          payload: result
        });
        count += 1;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (warnings.length === 0) {
      await this.markMissingObservations({
        endpoint: 'trade-volume',
        presentEntityIds,
        observedAtMs: now
      });
    }
    await this.updateCursor({
      executor: this.db,
      endpoint: 'trade-volume',
      count,
      now,
      completeness: warnings.length === 0 ? 'complete' : 'partial',
      cursor: {
        pairCount: pairs.length,
        chunkCount: chunks.length,
        ...(warnings.length === 0 ? {} : { warnings })
      }
    });
  }

  private async syncCreditLines() {
    const now = Date.now();
    try {
      const result = await this.client.privateQuery<Record<string, unknown>>({
        path: '/0/private/CreditLines'
      });
      await this.recordObservation({
        endpoint: 'credit-lines',
        entityId: 'account',
        observedAtMs: now,
        payload: result
      });
      await this.updateCursor({
        executor: this.db,
        endpoint: 'credit-lines',
        count: 1,
        now,
        completeness: 'complete'
      });
    } catch (error) {
      await this.updateCursor({
        executor: this.db,
        endpoint: 'credit-lines',
        count: 0,
        now,
        completeness: 'partial',
        error
      });
    }
  }

  private async primaryCurrency() {
    const row = await this.db.one<{ setting_value_json: string }>({
      sql: `
        SELECT setting_value_json FROM user_settings
        WHERE setting_key = 'primaryCurrency'
        ORDER BY updated_at_ms DESC
        LIMIT 1
      `
    });
    try {
      const value = JSON.parse(row?.setting_value_json ?? 'null') as unknown;
      return typeof value === 'string' && value.length === 3
        ? value.toUpperCase()
        : this.runtime.config.ui.defaultPrimaryCurrency;
    } catch {
      return this.runtime.config.ui.defaultPrimaryCurrency;
    }
  }

  private async configuredTooltipCurrencies() {
    const [primaryCurrency, row] = await Promise.all([
      this.primaryCurrency(),
      this.db.one<{ setting_value_json: string }>({
        sql: `
          SELECT setting_value_json FROM user_settings
          WHERE setting_key = 'tooltipCurrencies'
          ORDER BY updated_at_ms DESC
          LIMIT 1
        `
      })
    ]);
    try {
      const value = JSON.parse(row?.setting_value_json ?? 'null') as unknown;
      const configured = Array.isArray(value)
        ? value.map(String).map((currency) => currency.toUpperCase())
          .filter((currency) => /^[A-Z]{3}$/.test(currency))
        : this.runtime.config.ui.defaultTooltipCurrencies;
      return [...new Set([primaryCurrency, ...configured])];
    } catch {
      return [...new Set([
        primaryCurrency,
        ...this.runtime.config.ui.defaultTooltipCurrencies
      ])];
    }
  }

  private async historicalQuoteLookup({
    assetIds,
    quoteCurrencies,
    fromMs,
    toMs,
    queryGranularitySeconds
  }: {
    assetIds: string[];
    quoteCurrencies: string[];
    fromMs: number;
    toMs: number;
    queryGranularitySeconds?: number;
  }) {
    type HistoricalQuoteRow = {
      provider: string;
      canonical_asset_id: string;
      quote_currency: string;
      bucket_start_ms: number | string;
      granularity_seconds: number | string;
      close_value: string;
      data_kind: 'native' | 'derived';
    };
    const normalizedAssetIds = [...new Set(assetIds.filter(Boolean))];
    const normalizedCurrencies = [...new Set(
      quoteCurrencies.map((currency) => currency.toUpperCase())
        .filter((currency) => /^[A-Z]{3}$/.test(currency))
    )];
    const rows = normalizedAssetIds.length === 0 || normalizedCurrencies.length === 0
      ? []
      : await this.db.query<HistoricalQuoteRow>({
          sql: `
            WITH ranked_points AS (
              SELECT provider, canonical_asset_id, quote_currency,
                     bucket_start_ms, granularity_seconds, close_value,
                     data_kind,
                     ROW_NUMBER() OVER (
                       PARTITION BY provider, canonical_asset_id, quote_currency,
                                    CAST(bucket_start_ms / ? AS INTEGER)
                       ORDER BY bucket_start_ms DESC,
                                granularity_seconds ASC,
                                CASE WHEN data_kind = 'native' THEN 0 ELSE 1 END
                     ) AS bucket_rank
              FROM market_points
              WHERE canonical_asset_id IN (${normalizedAssetIds.map(() => '?').join(', ')})
                AND quote_currency IN (${normalizedCurrencies.map(() => '?').join(', ')})
                AND bucket_start_ms >= ?
                AND bucket_start_ms <= ?
            )
            SELECT provider, canonical_asset_id, quote_currency, bucket_start_ms,
                   granularity_seconds, close_value, data_kind
            FROM ranked_points
            WHERE bucket_rank = 1
            ORDER BY canonical_asset_id, quote_currency, bucket_start_ms,
                     granularity_seconds, provider, data_kind DESC
          `,
          parameters: [
            Math.max(1, Math.floor(queryGranularitySeconds ?? 300)) * 1_000,
            ...normalizedAssetIds,
            ...normalizedCurrencies,
            Math.max(0, fromMs - 7 * 24 * 60 * 60_000),
            toMs
          ]
        });
    const byPair = Map.groupBy(
      rows,
      (row) => `${row.canonical_asset_id}:${row.quote_currency.toUpperCase()}`
    );
    const cache = new Map<string, string | null>();
    return ({
      assetId,
      quoteCurrency,
      timestampMs
    }: {
      assetId: string;
      quoteCurrency: string;
      timestampMs: number;
    }) => {
      const currency = quoteCurrency.toUpperCase();
      if (assetId === currency.toLowerCase()) return '1';
      const cacheKey = `${assetId}:${currency}:${timestampMs}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
      const candidates = byPair.get(`${assetId}:${currency}`) ?? [];
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
      let last = found;
      while (
        last + 1 < candidates.length
        && Number(candidates[last + 1]!.bucket_start_ms) === bucketStartMs
      ) {
        last += 1;
      }
      const byProvider = new Map<string, HistoricalQuoteRow>();
      for (const row of candidates.slice(first, last + 1)) {
        const existing = byProvider.get(row.provider);
        if (
          !existing
          || (row.data_kind === 'native' && existing.data_kind !== 'native')
          || (
            row.data_kind === existing.data_kind
            && Number(row.granularity_seconds) < Number(existing.granularity_seconds)
          )
        ) {
          byProvider.set(row.provider, row);
        }
      }
      const value = combinePriceObservations({
        observations: [...byProvider.values()].map((row) => ({
          provider: row.provider,
          value: row.close_value,
          dataKind: row.data_kind
        })),
        disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
      }).value;
      cache.set(cacheKey, value);
      return value;
    };
  }

  private async latestPrice({
    assetId,
    quoteCurrency
  }: {
    assetId: string;
    quoteCurrency: string;
  }) {
    if (assetId === quoteCurrency.toLowerCase()) return '1';
    const rows = await this.db.query<{
      provider: string;
      close_value: string;
      data_kind: 'native' | 'derived';
    }>({
      sql: `
        SELECT provider, close_value, data_kind
        FROM market_points
        WHERE canonical_asset_id = ? AND quote_currency = ?
          AND bucket_start_ms = (
            SELECT MAX(bucket_start_ms) FROM market_points
            WHERE canonical_asset_id = ? AND quote_currency = ?
          )
        ORDER BY provider
      `,
      parameters: [assetId, quoteCurrency, assetId, quoteCurrency]
    });
    return combinePriceObservations({
      observations: rows.map((row) => ({
        provider: row.provider,
        value: row.close_value,
        dataKind: row.data_kind
      })),
      disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
    }).value;
  }

  private async writeSnapshot({
    balances,
    detectChanges = false
  }: {
    balances: Record<string, string>;
    detectChanges?: boolean;
  }) {
    const capturedAtMs = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000);
    const id = createId({ prefix: 'ksn' });
    const primaryCurrency = await this.primaryCurrency();
    let total = new Decimal(0);
    let priced = 0;
    let countable = 0;
    const valued: Array<{
      assetRaw: string;
      canonicalAssetId: string;
      category: string;
      quantity: string;
      value: string | null;
    }> = [];
    for (const [assetRaw, quantity] of Object.entries(balances)) {
      const canonicalAssetId = canonicalKrakenAsset({ raw: assetRaw });
      const category = krakenAssetCategory({ raw: assetRaw });
      const price = await this.latestPrice({
        assetId: canonicalAssetId,
        quoteCurrency: primaryCurrency
      });
      const value = price === null ? null : new Decimal(quantity).times(price).toString();
      const nonZero = !new Decimal(quantity).isZero();
      if (nonZero) countable += 1;
      if (value !== null && nonZero) {
        total = total.plus(value);
        priced += 1;
      }
      valued.push({
        assetRaw,
        canonicalAssetId,
        category,
        quantity,
        value
      });
    }
    const existingSnapshot = detectChanges
      ? await this.db.one<{
          id: string;
          total_value_currency: string;
          total_value: string;
          price_coverage: string;
        }>({
          sql: `
            SELECT id, total_value_currency, total_value, price_coverage
            FROM kraken_snapshots
            WHERE captured_at_ms = ?
          `,
          parameters: [capturedAtMs]
        })
      : null;
    const existingBalances = existingSnapshot
      ? await this.db.query<{
          asset_raw: string;
          canonical_asset_id: string;
          category: string;
          quantity: string;
          value_amount: string | null;
        }>({
          sql: `
            SELECT asset_raw, canonical_asset_id, category, quantity, value_amount
            FROM kraken_snapshot_balances
            WHERE snapshot_id = ?
            ORDER BY asset_raw, category
          `,
          parameters: [existingSnapshot.id]
        })
      : [];
    const coverage = countable === 0
      ? '100'
      : new Decimal(priced).dividedBy(countable).times(100).toString();
    const decimalEquals = (left: string | null, right: string | null) => (
      left === null || right === null
        ? left === right
        : new Decimal(left).equals(right)
    );
    const expectedBalances = [...valued].sort((left, right) => (
      left.assetRaw.localeCompare(right.assetRaw) || left.category.localeCompare(right.category)
    ));
    const changed = detectChanges && (
      !existingSnapshot
        || existingSnapshot.total_value_currency !== primaryCurrency
        || !decimalEquals(existingSnapshot.total_value, total.toString())
        || !decimalEquals(existingSnapshot.price_coverage, coverage)
        || existingBalances.length !== expectedBalances.length
        || expectedBalances.some((balance, index) => {
          const existing = existingBalances[index];
          return !existing
            || existing.asset_raw !== balance.assetRaw
            || existing.canonical_asset_id !== balance.canonicalAssetId
            || existing.category !== balance.category
            || !decimalEquals(existing.quantity, balance.quantity)
            || !decimalEquals(existing.value_amount, balance.value);
        })
    );
    await this.db.transaction({
      task: async (executor) => {
        await executor.run({
          sql: `
            INSERT INTO kraken_snapshots(
              id, captured_at_ms, total_value_currency, total_value, price_coverage, provenance_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(captured_at_ms) DO UPDATE SET
              total_value = excluded.total_value,
              price_coverage = excluded.price_coverage,
              provenance_json = excluded.provenance_json
          `,
          parameters: [
            id,
            capturedAtMs,
            primaryCurrency,
            total.toString(),
            coverage,
            JSON.stringify({
              marketSource: this.runtime.config.ui.defaultMarketSource,
              capturedBy: 'kraken.read-only'
            })
          ]
        });
        const snapshot = await executor.one<{ id: string }>({
          sql: 'SELECT id FROM kraken_snapshots WHERE captured_at_ms = ?',
          parameters: [capturedAtMs]
        });
        await executor.run({
          sql: 'DELETE FROM kraken_snapshot_balances WHERE snapshot_id = ?',
          parameters: [snapshot!.id]
        });
        for (const balance of valued) {
          await executor.run({
            sql: `
              INSERT INTO kraken_snapshot_balances(
                snapshot_id, asset_raw, canonical_asset_id, category,
                quantity, value_currency, value_amount, priced
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(snapshot_id, asset_raw, category) DO UPDATE SET
                quantity = excluded.quantity,
                value_amount = excluded.value_amount,
                priced = excluded.priced
            `,
            parameters: [
              snapshot!.id,
              balance.assetRaw,
              balance.canonicalAssetId,
              balance.category,
              balance.quantity,
              primaryCurrency,
              balance.value,
              balance.value === null ? 0 : 1
            ]
          });
        }
      }
    });
    return {
      changed,
      assetIds: [...new Set(valued.map((balance) => balance.canonicalAssetId))]
    };
  }

  private async updateCursor({
    executor,
    endpoint,
    count,
    now,
    completeness = 'partial',
    error = null,
    cursor = {},
    oldestAtMs = null,
    newestAtMs = now
  }: {
    executor: Pick<AppDatabase, 'run'>;
    endpoint: string;
    count: number;
    now: number;
    completeness?: 'complete' | 'partial' | 'syncing';
    error?: unknown;
    cursor?: Record<string, unknown>;
    oldestAtMs?: number | null;
    newestAtMs?: number | null;
  }) {
    const lastSuccessAtMs = !error && completeness === 'complete' ? now : null;
    await executor.run({
      sql: `
        INSERT INTO kraken_sync_cursors(
          endpoint, cursor_json, completeness, oldest_at_ms, newest_at_ms, last_success_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          cursor_json = excluded.cursor_json,
          completeness = excluded.completeness,
          oldest_at_ms = CASE
            WHEN excluded.oldest_at_ms IS NULL THEN kraken_sync_cursors.oldest_at_ms
            WHEN kraken_sync_cursors.oldest_at_ms IS NULL
              OR excluded.oldest_at_ms < kraken_sync_cursors.oldest_at_ms
            THEN excluded.oldest_at_ms ELSE kraken_sync_cursors.oldest_at_ms END,
          newest_at_ms = CASE
            WHEN excluded.newest_at_ms IS NULL THEN kraken_sync_cursors.newest_at_ms
            WHEN kraken_sync_cursors.newest_at_ms IS NULL
              OR excluded.newest_at_ms > kraken_sync_cursors.newest_at_ms
            THEN excluded.newest_at_ms ELSE kraken_sync_cursors.newest_at_ms END,
          last_success_at_ms = COALESCE(excluded.last_success_at_ms, kraken_sync_cursors.last_success_at_ms),
          updated_at_ms = excluded.updated_at_ms
      `,
      parameters: [
        endpoint,
        JSON.stringify({
          count,
          ...cursor,
          ...(error ? { warning: error instanceof Error ? error.message : String(error) } : {})
        }),
        completeness,
        oldestAtMs,
        newestAtMs,
        lastSuccessAtMs,
        now
      ]
    });
  }

  async status() {
    const cursors = await this.db.query<{
      endpoint: string;
      completeness: string;
      last_success_at_ms: number | string | null;
    }>({
      sql: 'SELECT endpoint, completeness, last_success_at_ms FROM kraken_sync_cursors ORDER BY endpoint'
    });
    return {
      configured: this.client.isConfigured(),
      connected: cursors.some((cursor) => cursor.last_success_at_ms !== null),
      readOnly: this.permissionState?.safe ?? null,
      permissionInspection: this.permissionState ?? {
        available: false,
        safe: null,
        permissions: [],
        required: [],
        missing: [],
        unsafe: []
      },
      provider: this.client.status(),
      cursors: cursors.map((cursor) => ({
        endpoint: cursor.endpoint,
        completeness: cursor.completeness,
        lastSuccessfulSync: cursor.last_success_at_ms
          ? new Date(Number(cursor.last_success_at_ms)).toISOString()
          : null
      }))
    };
  }

  async holdings() {
    const snapshot = await this.db.one<{
      id: string;
      captured_at_ms: number | string;
      total_value_currency: string;
      total_value: string;
      price_coverage: string;
    }>({
      sql: 'SELECT * FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1'
    });
    if (!snapshot) return [];
    const rows = await this.db.query<{
      asset_raw: string;
      canonical_asset_id: string | null;
      category: string;
      quantity: string;
      value_currency: string | null;
      value_amount: string | null;
      priced: number | string;
    }>({
      sql: `
        SELECT * FROM kraken_snapshot_balances
        WHERE snapshot_id = ?
        ORDER BY category, canonical_asset_id, asset_raw
      `,
      parameters: [snapshot.id]
    });
    const holdings = rows.map((row) => ({
      assetRaw: row.asset_raw,
      assetId: row.canonical_asset_id,
      category: row.category,
      quantity: row.quantity,
      valueCurrency: row.value_currency,
      valueAmount: row.value_amount,
      priced: Boolean(Number(row.priced)),
      capturedAt: new Date(Number(snapshot.captured_at_ms)).toISOString()
    }));
    return Promise.all(holdings.map(async (holding) => {
      if (holding.priced) {
        return {
          ...holding,
          currentPrice: holding.valueAmount === null || new Decimal(holding.quantity).isZero()
            ? null
            : new Decimal(holding.valueAmount).dividedBy(holding.quantity).toString(),
          pricingReason: null
        };
      }
      const [mapping, cachedPrice] = await Promise.all([
        this.db.one<{ count: number | string }>({
          sql: 'SELECT COUNT(*) AS count FROM asset_provider_mappings WHERE canonical_asset_id = ?',
          parameters: [holding.assetId]
        }),
        this.db.one<{ count: number | string }>({
          sql: 'SELECT COUNT(*) AS count FROM market_points WHERE canonical_asset_id = ? AND quote_currency = ?',
          parameters: [holding.assetId, holding.valueCurrency]
        })
      ]);
      const mappingCount = Number(mapping?.count ?? 0);
      const cachedPriceCount = Number(cachedPrice?.count ?? 0);
      return {
        ...holding,
        currentPrice: null,
        pricingReason: mappingCount === 0
          ? 'No market-provider identity is mapped for this Kraken asset.'
          : cachedPriceCount === 0
            ? `The asset is mapped, but no ${holding.valueCurrency ?? 'selected-currency'} price has synchronized yet.`
            : 'Cached prices exist, but none could produce a compatible current valuation.'
      };
    }));
  }

  async earnAllocations() {
    const rows = await this.db.query<{
      allocation_id: string;
      asset_raw: string;
      canonical_asset_id: string | null;
      product_id: string | null;
      quantity: string;
      reward_quantity: string | null;
      state: string;
      captured_at_ms: number | string;
    }>({
      sql: `
        SELECT allocation_id, asset_raw, canonical_asset_id, product_id,
               quantity, reward_quantity, state, captured_at_ms
        FROM kraken_earn_allocations
        WHERE quantity != '0' OR COALESCE(reward_quantity, '0') != '0'
        ORDER BY canonical_asset_id, asset_raw, allocation_id
      `
    });
    return rows.map((row) => ({
      allocationId: row.allocation_id,
      assetRaw: row.asset_raw,
      assetId: canonicalKrakenAsset({ raw: row.asset_raw }),
      productId: row.product_id,
      quantity: row.quantity,
      rewardQuantity: row.reward_quantity,
      state: row.state,
      capturedAt: new Date(Number(row.captured_at_ms)).toISOString()
    }));
  }

  async earnOverview({
    fromMs,
    toMs,
    quoteCurrencies,
    granularitySeconds = 86_400
  }: {
    fromMs: number;
    toMs: number;
    quoteCurrencies?: string[];
    granularitySeconds?: number;
  }) {
    const [
      currentRows,
      historyRows,
      earnLedgerRows,
      allocations,
      strategyRateRows,
      currency,
      configuredCurrencies,
      denominationOptions,
      ledgerState,
      strategyState
    ] = await Promise.all([
      this.db.query<{
        captured_at_ms: number | string;
        asset_raw: string;
        quantity: string;
        value_amount: string | null;
        priced: number | string;
      }>({
        sql: `
          SELECT snapshot.captured_at_ms, balance.asset_raw, balance.quantity,
                 balance.value_amount, balance.priced
          FROM kraken_snapshot_balances AS balance
          JOIN kraken_snapshots AS snapshot ON snapshot.id = balance.snapshot_id
          WHERE balance.snapshot_id = (
            SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1
          )
            AND (
              balance.category = 'earn'
              OR balance.asset_raw LIKE '%.S'
              OR balance.asset_raw LIKE '%.B'
              OR balance.asset_raw LIKE '%.M'
              OR balance.asset_raw LIKE '%.F'
            )
          ORDER BY balance.asset_raw
        `
      }),
      this.db.query<{
        captured_at_ms: number | string;
        asset_raw: string;
        quantity: string;
        value_amount: string | null;
        priced: number | string;
      }>({
        sql: `
          SELECT snapshot.captured_at_ms, balance.asset_raw, balance.quantity,
                 balance.value_amount, balance.priced
          FROM kraken_snapshot_balances AS balance
          JOIN kraken_snapshots AS snapshot ON snapshot.id = balance.snapshot_id
          WHERE snapshot.captured_at_ms <= ?
            AND (
              balance.category = 'earn'
              OR balance.asset_raw LIKE '%.S'
              OR balance.asset_raw LIKE '%.B'
              OR balance.asset_raw LIKE '%.M'
              OR balance.asset_raw LIKE '%.F'
            )
          ORDER BY snapshot.captured_at_ms, balance.asset_raw
        `,
        parameters: [toMs]
      }),
      this.db.query<{
        asset_raw: string;
        event_type: string;
        subtype: string | null;
        occurred_at_ms: number | string;
        amount: string;
      }>({
        sql: `
          SELECT asset_raw, event_type, subtype, occurred_at_ms, amount
          FROM kraken_ledgers
          WHERE occurred_at_ms <= ?
            AND (
              event_type IN ('staking', 'earn', 'reward')
              OR LOWER(COALESCE(subtype, '')) LIKE '%staking%'
              OR LOWER(COALESCE(subtype, '')) = 'autoallocation'
            )
          ORDER BY occurred_at_ms, kraken_id
        `,
        parameters: [toMs]
      }),
      this.earnAllocations(),
      this.db.query<{
        strategy_id: string;
        asset_raw: string;
        canonical_asset_id: string | null;
        captured_at_ms: number | string;
        apy_low_percent: string;
        apy_high_percent: string;
      }>({
        sql: `
          SELECT strategy_id, asset_raw, canonical_asset_id, captured_at_ms,
                 apy_low_percent, apy_high_percent
          FROM kraken_earn_strategy_rates
          WHERE captured_at_ms <= ?
          ORDER BY captured_at_ms, strategy_id
        `,
        parameters: [toMs]
      }),
      this.primaryCurrency(),
      quoteCurrencies === undefined
        ? this.configuredTooltipCurrencies()
        : Promise.resolve(quoteCurrencies),
      enabledChartDenominations({ db: this.db }),
      this.cursorState({ endpoint: 'ledgers' }),
      this.cursorState({ endpoint: 'earn-strategies' })
    ]);
    const resolvedQuoteCurrencies = [...new Set([
      currency,
      'USD',
      ...configuredCurrencies.map((configured) => configured.toUpperCase())
        .filter((configured) => /^[A-Z]{3}$/.test(configured))
    ])];
    const assetIds = [...new Set([
      ...currentRows.map((row) => canonicalKrakenAsset({ raw: row.asset_raw })),
      ...historyRows.map((row) => canonicalKrakenAsset({ raw: row.asset_raw })),
      ...earnLedgerRows.map((row) => canonicalKrakenAsset({ raw: row.asset_raw })),
      ...allocations.map((allocation) => allocation.assetId)
    ].filter(Boolean))];
    const priceAssetIds = [...new Set([
      ...assetIds,
      ...denominationOptions.map((option) => option.id)
    ])];
    const catalogRows = assetIds.length === 0
      ? []
      : await this.db.query<{ canonical_id: string; symbol: string; name: string }>({
          sql: `
            SELECT canonical_id, symbol, name
            FROM asset_catalog
            WHERE canonical_id IN (${assetIds.map(() => '?').join(', ')})
          `,
          parameters: assetIds
        });
    const labels = new Map(catalogRows.map((row) => [
      row.canonical_id,
      `${row.symbol} · ${row.name}`
    ]));
    const currentByAsset = new Map<string, {
      quantity: Decimal;
      value: Decimal;
      priced: boolean;
      unpriced: boolean;
      capturedAtMs: number;
    }>();
    for (const row of currentRows) {
      const assetId = canonicalKrakenAsset({ raw: row.asset_raw });
      const current = currentByAsset.get(assetId) ?? {
        quantity: new Decimal(0),
        value: new Decimal(0),
        priced: false,
        unpriced: false,
        capturedAtMs: Number(row.captured_at_ms)
      };
      current.quantity = current.quantity.plus(row.quantity);
      if (Boolean(Number(row.priced)) && row.value_amount !== null) {
        current.value = current.value.plus(row.value_amount);
        current.priced = true;
      } else {
        current.unpriced = true;
      }
      current.capturedAtMs = Math.max(current.capturedAtMs, Number(row.captured_at_ms));
      currentByAsset.set(assetId, current);
    }
    const allocationsByAsset = new Map<string, {
      quantity: Decimal;
      reward: Decimal;
      count: number;
      states: Set<string>;
      strategyIds: Set<string>;
    }>();
    for (const allocation of allocations) {
      const current = allocationsByAsset.get(allocation.assetId) ?? {
        quantity: new Decimal(0),
        reward: new Decimal(0),
        count: 0,
        states: new Set<string>(),
        strategyIds: new Set<string>()
      };
      current.quantity = current.quantity.plus(allocation.quantity);
      current.reward = current.reward.plus(allocation.rewardQuantity ?? 0);
      current.count += 1;
      current.states.add(allocation.state);
      if (allocation.productId) current.strategyIds.add(allocation.productId);
      allocationsByAsset.set(allocation.assetId, current);
    }
    const latestStrategyRateById = new Map<string, typeof strategyRateRows[number]>();
    for (const rate of strategyRateRows) latestStrategyRateById.set(rate.strategy_id, rate);
    const applicableStrategyRates = ({
      assetId,
      latestOnly = false
    }: {
      assetId: string;
      latestOnly?: boolean;
    }) => {
      const strategyIds = allocationsByAsset.get(assetId)?.strategyIds ?? new Set<string>();
      const rates = latestOnly
        ? [...latestStrategyRateById.values()]
        : strategyRateRows;
      return rates.filter((rate) => (
        canonicalKrakenAsset({ raw: rate.asset_raw }) === assetId
        && (strategyIds.size === 0 || strategyIds.has(rate.strategy_id))
      ));
    };
    const valuesByAsset = new Map<string, Map<number, {
      quantity: Decimal;
      value: Decimal;
      priced: boolean;
      unpriced: boolean;
      inferred?: boolean;
    }>>();
    for (const row of historyRows) {
      const assetId = canonicalKrakenAsset({ raw: row.asset_raw });
      const timestampMs = Number(row.captured_at_ms);
      const values = valuesByAsset.get(assetId) ?? new Map();
      const current = values.get(timestampMs) ?? {
        quantity: new Decimal(0),
        value: new Decimal(0),
        priced: false,
        unpriced: false
      };
      current.quantity = current.quantity.plus(row.quantity);
      if (Boolean(Number(row.priced)) && row.value_amount !== null) {
        current.value = current.value.plus(row.value_amount);
        current.priced = true;
      } else {
        current.unpriced = true;
      }
      values.set(timestampMs, current);
      valuesByAsset.set(assetId, values);
    }
    const ledgerDeltas = new Map<number, Map<string, Decimal>>();
    const isEarnRawAsset = (assetRaw: string) => /\.(S|B|M|F)$/i.test(assetRaw);
    for (const row of earnLedgerRows) {
      const amount = new Decimal(row.amount);
      const subtype = row.subtype?.toLowerCase() ?? '';
      const reward = ['staking', 'earn', 'reward'].includes(row.event_type)
        && isEarnRawAsset(row.asset_raw);
      const allocationTransfer = isEarnRawAsset(row.asset_raw)
        && ['spottostaking', 'stakingtospot', 'autoallocation'].includes(subtype);
      const affectsEarnBalance = reward || allocationTransfer;
      if (!affectsEarnBalance) continue;
      const timestampMs = Number(row.occurred_at_ms);
      const assetId = canonicalKrakenAsset({ raw: row.asset_raw });
      const byAsset = ledgerDeltas.get(timestampMs) ?? new Map<string, Decimal>();
      byAsset.set(assetId, (byAsset.get(assetId) ?? new Decimal(0)).plus(amount));
      ledgerDeltas.set(timestampMs, byAsset);
    }
    const snapshotStates = new Map<number, Map<string, Decimal>>();
    const snapshotAssetIds = new Set<string>();
    for (const row of historyRows) {
      const timestampMs = Number(row.captured_at_ms);
      const assetId = canonicalKrakenAsset({ raw: row.asset_raw });
      const snapshot = snapshotStates.get(timestampMs) ?? new Map<string, Decimal>();
      snapshot.set(assetId, (snapshot.get(assetId) ?? new Decimal(0)).plus(row.quantity));
      snapshotStates.set(timestampMs, snapshot);
      snapshotAssetIds.add(assetId);
    }
    const allocationObservationStates = new Map<number, Map<string, Decimal>>();
    for (const allocation of allocations) {
      if (snapshotAssetIds.has(allocation.assetId)) continue;
      const timestampMs = Date.parse(allocation.capturedAt);
      if (!Number.isFinite(timestampMs) || timestampMs > toMs) continue;
      const observation = allocationObservationStates.get(timestampMs) ?? new Map<string, Decimal>();
      observation.set(
        allocation.assetId,
        (observation.get(allocation.assetId) ?? new Decimal(0)).plus(allocation.quantity)
      );
      allocationObservationStates.set(timestampMs, observation);
    }
    const oldestCandidate = [
      ...earnLedgerRows.map((row) => Number(row.occurred_at_ms)),
      ...ledgerDeltas.keys(),
      ...snapshotStates.keys(),
      ...allocationObservationStates.keys()
    ].sort((left, right) => left - right)[0];
    const effectiveFromMs = fromMs === 0 ? oldestCandidate ?? toMs : fromMs;
    const requestedGranularitySeconds = Math.max(60, Math.floor(granularitySeconds));
    const earnAssetCount = new Set([
      ...earnLedgerRows.map((row) => canonicalKrakenAsset({ raw: row.asset_raw })),
      ...[...ledgerDeltas.values()].flatMap((values) => [...values.keys()]),
      ...snapshotAssetIds,
      ...allocations.map((allocation) => allocation.assetId)
    ]).size;
    const resolvedGranularitySeconds = boundedOverviewGranularity({
      requestedGranularity: requestedGranularitySeconds,
      fromMs: effectiveFromMs,
      toMs,
      seriesCount: Math.max(1, earnAssetCount * 2 + 1)
    });
    const timeline = new Set<number>([effectiveFromMs, toMs]);
    for (
      let timestampMs = effectiveFromMs;
      timestampMs <= toMs;
      timestampMs += resolvedGranularitySeconds * 1_000
    ) {
      timeline.add(timestampMs);
    }
    const timestamps = [...timeline].sort((left, right) => left - right);
    const quoteAt = await this.historicalQuoteLookup({
      assetIds: priceAssetIds,
      quoteCurrencies: resolvedQuoteCurrencies,
      fromMs: effectiveFromMs,
      toMs,
      queryGranularitySeconds: resolvedGranularitySeconds
    });
    type BalanceAction = {
      timestampMs: number;
      order: number;
      kind: 'delta' | 'snapshot' | 'allocation';
      values: Map<string, Decimal>;
    };
    const actions: BalanceAction[] = [
      ...[...ledgerDeltas.entries()].map(([timestampMs, values]) => ({
        timestampMs,
        order: 0,
        kind: 'delta' as const,
        values
      })),
      ...[...snapshotStates.entries()].map(([timestampMs, values]) => ({
        timestampMs,
        order: 1,
        kind: 'snapshot' as const,
        values
      })),
      ...[...allocationObservationStates.entries()].map(([timestampMs, values]) => ({
        timestampMs,
        order: 2,
        kind: 'allocation' as const,
        values
      }))
    ].sort((left, right) => (
      left.timestampMs - right.timestampMs || left.order - right.order
    ));
    const ledgerComplete = ledgerState.completeness === 'complete';
    const reconstructedQuantities = new Map<string, Decimal | null>(
      assetIds.map((assetId) => [assetId, ledgerComplete ? new Decimal(0) : null])
    );
    valuesByAsset.clear();
    let actionIndex = 0;
    let hasBalanceGap = false;
    for (const timestampMs of timestamps) {
      while (actions[actionIndex] && actions[actionIndex]!.timestampMs <= timestampMs) {
        const action = actions[actionIndex]!;
        if (action.kind === 'snapshot') {
          for (const assetId of snapshotAssetIds) {
            reconstructedQuantities.set(assetId, new Decimal(0));
          }
          for (const [assetId, quantity] of action.values) {
            reconstructedQuantities.set(assetId, quantity);
          }
        } else if (action.kind === 'allocation') {
          for (const [assetId, quantity] of action.values) {
            reconstructedQuantities.set(assetId, quantity);
          }
        } else {
          for (const [assetId, delta] of action.values) {
            const quantity = reconstructedQuantities.get(assetId);
            if (quantity !== null && quantity !== undefined) {
              const nextQuantity = quantity.plus(delta);
              if (nextQuantity.isNegative()) {
                reconstructedQuantities.set(assetId, null);
                hasBalanceGap = true;
              } else {
                reconstructedQuantities.set(assetId, nextQuantity);
              }
            }
          }
        }
        actionIndex += 1;
      }
      for (const [assetId, quantity] of reconstructedQuantities) {
        if (quantity === null) continue;
        const values = valuesByAsset.get(assetId) ?? new Map();
        values.set(timestampMs, {
          quantity,
          value: new Decimal(0),
          priced: false,
          unpriced: false,
          inferred: true
        });
        valuesByAsset.set(assetId, values);
      }
    }
    for (const [assetId, values] of valuesByAsset) {
      for (const [timestampMs, value] of values) {
        if (!value.inferred) continue;
        if (value.quantity.isZero()) {
          value.value = new Decimal(0);
          value.priced = true;
          continue;
        }
        const unitPrice = quoteAt({
          assetId,
          quoteCurrency: currency,
          timestampMs
        });
        if (unitPrice === null) {
          value.unpriced = !value.quantity.isZero();
          continue;
        }
        value.value = value.quantity.times(unitPrice);
        value.priced = true;
      }
    }
    const assetQuotes = ({
      assetId,
      timestampMs,
      value
    }: {
      assetId: string;
      timestampMs: number;
      value: {
        quantity: Decimal;
        value: Decimal;
        priced: boolean;
      };
    }) => Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
      if (value.quantity.isZero()) return [quoteCurrency, '0'];
      const price = quoteAt({ assetId, quoteCurrency, timestampMs });
      return [
        quoteCurrency,
        price !== null
          ? value.quantity.times(price).toString()
          : quoteCurrency === currency && value.priced
            ? value.value.toString()
            : null
      ];
    }));
    const denominationsAt = ({
      quoteValues,
      timestampMs
    }: {
      quoteValues: Record<string, string | null | undefined>;
      timestampMs: number;
    }) => chartDenominationsAt({
      denominationOptions,
      quoteValues,
      primaryCurrency: currency,
      timestampMs,
      priceAt: quoteAt
    });
    const valuesByTimestamp = new Map<number, {
      value: Decimal;
      pricedAssets: number;
      unpricedAssets: number;
      quotes: Map<string, Decimal>;
      quantities: Map<string, Decimal>;
    }>();
    for (const [assetId, values] of valuesByAsset) {
      for (const [timestampMs, assetValue] of values) {
        const current = valuesByTimestamp.get(timestampMs) ?? {
          value: new Decimal(0),
          pricedAssets: 0,
          unpricedAssets: 0,
          quotes: new Map<string, Decimal>(),
          quantities: new Map<string, Decimal>()
        };
        if (assetValue.priced) {
          current.value = current.value.plus(assetValue.value);
          current.pricedAssets += 1;
        }
        if (assetValue.unpriced) current.unpricedAssets += 1;
        current.quantities.set(
          assetId,
          (current.quantities.get(assetId) ?? new Decimal(0)).plus(assetValue.quantity)
        );
        for (const [quoteCurrency, quoteValue] of Object.entries(assetQuotes({
          assetId,
          timestampMs,
          value: assetValue
        }))) {
          if (quoteValue === null) continue;
          current.quotes.set(
            quoteCurrency,
            (current.quotes.get(quoteCurrency) ?? new Decimal(0)).plus(quoteValue)
          );
        }
        valuesByTimestamp.set(timestampMs, current);
      }
    }
    const allEvents = await krakenEvents({
      db: this.db,
      fromMs: effectiveFromMs,
      toMs
    });
    const earnAssetIds = new Set(assetIds);
    const earnEventCategories = new Set(['reward', 'stake', 'unstake']);
    const events = allEvents.filter((event) => (
      event.asset
      && earnAssetIds.has(event.asset)
      && earnEventCategories.has(event.category)
      && (
        event.category === 'reward'
        || (
          typeof event.details?.assetRaw === 'string'
          && isEarnRawAsset(event.details.assetRaw)
        )
      )
    ));
    const payoutDistributionByAsset = new Map<string, {
      quantity: Decimal;
      payoutCount: number;
      lastPayoutMs: number;
    }>();
    for (const event of events.filter((event) => event.category === 'reward' && event.asset)) {
      const current = payoutDistributionByAsset.get(event.asset!) ?? {
        quantity: new Decimal(0),
        payoutCount: 0,
        lastPayoutMs: 0
      };
      current.quantity = current.quantity.plus(event.quantity ?? 0);
      current.payoutCount += 1;
      current.lastPayoutMs = Math.max(current.lastPayoutMs, event.timestampMs);
      payoutDistributionByAsset.set(event.asset!, current);
    }
    const assets = assetIds
      .map((assetId) => {
        const current = currentByAsset.get(assetId);
        const allocation = allocationsByAsset.get(assetId);
        const quantity = current?.quantity ?? allocation?.quantity ?? new Decimal(0);
        const rewardQuantity = allocation?.reward ?? new Decimal(0);
        const currentValues = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
          if (quantity.isZero()) return [quoteCurrency, '0'];
          const price = quoteAt({
            assetId,
            quoteCurrency,
            timestampMs: toMs
          });
          return [
            quoteCurrency,
            price !== null
              ? quantity.times(price).toString()
              : quoteCurrency === currency && current?.priced
                ? current.value.toString()
                : null
          ];
        }));
        const rewardValues = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
          if (rewardQuantity.isZero()) return [quoteCurrency, '0'];
          const price = quoteAt({
            assetId,
            quoteCurrency,
            timestampMs: toMs
          });
          return [
            quoteCurrency,
            price === null ? null : rewardQuantity.times(price).toString()
          ];
        }));
        const rates = applicableStrategyRates({ assetId, latestOnly: true });
        const apyLowPercent = rates.length === 0
          ? null
          : Decimal.min(...rates.map((rate) => rate.apy_low_percent)).toString();
        const apyHighPercent = rates.length === 0
          ? null
          : Decimal.max(...rates.map((rate) => rate.apy_high_percent)).toString();
        return {
          assetId,
          label: labels.get(assetId) ?? assetId,
          quantity: quantity.toString(),
          valueAmount: current?.priced ? current.value.toString() : null,
          currentValues,
          priced: current?.priced ?? false,
          rewardQuantity: rewardQuantity.toString(),
          rewardValues,
          allocationCount: allocation?.count ?? 0,
          states: [...(allocation?.states ?? [])].sort(),
          capturedAt: current ? new Date(current.capturedAtMs).toISOString() : null,
          apyLowPercent,
          apyHighPercent,
          apyCapturedAt: rates.length === 0
            ? null
            : new Date(Math.max(...rates.map((rate) => Number(rate.captured_at_ms)))).toISOString()
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
    const totalValue = Decimal.sum(
      0,
      ...[...currentByAsset.values()]
        .filter((asset) => asset.priced)
        .map((asset) => asset.value)
    );
    let totalRewardValue = new Decimal(0);
    let pricedRewardAssetCount = 0;
    for (const [assetId, allocation] of allocationsByAsset) {
      const current = currentByAsset.get(assetId);
      if (
        !current?.priced
        || current.quantity.isZero()
        || allocation.reward.isZero()
      ) continue;
      totalRewardValue = totalRewardValue.plus(
        allocation.reward.times(current.value).dividedBy(current.quantity)
      );
      pricedRewardAssetCount += 1;
    }
    const values = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
      const known = assets
        .map((asset) => asset.currentValues[quoteCurrency])
        .filter((value): value is string => value !== null);
      return [
        quoteCurrency,
        known.length === 0 ? null : Decimal.sum(0, ...known).toString()
      ];
    }));
    const rewardValues = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
      const known = assets
        .map((asset) => asset.rewardValues[quoteCurrency])
        .filter((value): value is string => value !== null);
      return [
        quoteCurrency,
        known.length === 0 ? null : Decimal.sum(0, ...known).toString()
      ];
    }));
    const apyPointsByAsset = new Map<string, Map<number, {
      low: Decimal;
      high: Decimal;
    }>>();
    for (const assetId of assetIds) {
      const byTimestamp = new Map<number, { low: Decimal; high: Decimal }>();
      for (const rate of applicableStrategyRates({ assetId })) {
        const timestampMs = Number(rate.captured_at_ms);
        const existing = byTimestamp.get(timestampMs);
        const low = new Decimal(rate.apy_low_percent);
        const high = new Decimal(rate.apy_high_percent);
        byTimestamp.set(timestampMs, existing
          ? {
              low: Decimal.min(existing.low, low),
              high: Decimal.max(existing.high, high)
            }
          : { low, high });
      }
      const beforeRange = [...byTimestamp.entries()]
        .filter(([timestampMs]) => timestampMs < effectiveFromMs)
        .at(-1)?.[1];
      const bucketed = new Map<number, { low: Decimal; high: Decimal }>();
      if (beforeRange) bucketed.set(effectiveFromMs, beforeRange);
      for (const [timestampMs, rate] of byTimestamp) {
        if (timestampMs < effectiveFromMs || timestampMs > toMs) continue;
        const bucket = Math.floor(timestampMs / (resolvedGranularitySeconds * 1_000))
          * resolvedGranularitySeconds * 1_000;
        bucketed.set(bucket, rate);
      }
      if (bucketed.size > 0) apyPointsByAsset.set(assetId, bucketed);
    }
    const apySeries = [...apyPointsByAsset.entries()].flatMap(([assetId, points]) => {
      const ordered = [...points.entries()].sort(([left], [right]) => left - right);
      const sameRate = ordered.every(([, point]) => point.low.equals(point.high));
      if (sameRate) {
        return [{
          id: `kraken-earn-apy:${assetId}`,
          label: `${labels.get(assetId) ?? assetId} APY`,
          points: ordered.map(([timestampMs, point]) => ({
            timestampMs,
            value: point.low.toString()
          }))
        }];
      }
      return [
        {
          id: `kraken-earn-apy:${assetId}:low`,
          label: `${labels.get(assetId) ?? assetId} APY low`,
          points: ordered.map(([timestampMs, point]) => ({
            timestampMs,
            value: point.low.toString()
          }))
        },
        {
          id: `kraken-earn-apy:${assetId}:high`,
          label: `${labels.get(assetId) ?? assetId} APY high`,
          points: ordered.map(([timestampMs, point]) => ({
            timestampMs,
            value: point.high.toString()
          }))
        }
      ];
    });
    const apyOldestAtMs = strategyRateRows.length === 0
      ? null
      : Math.min(...strategyRateRows.map((rate) => Number(rate.captured_at_ms)));
    return {
      summary: {
        totalValue: totalValue.toString(),
        totalRewardValue: totalRewardValue.toString(),
        currency,
        values,
        rewardValues,
        assetCount: assets.filter((asset) => !new Decimal(asset.quantity).isZero()).length,
        pricedAssetCount: [...currentByAsset.values()].filter((asset) => asset.priced).length,
        pricedRewardAssetCount,
        allocationCount: allocations.length
      },
      assets,
      allocations,
      events,
      activity: [...events].sort((left, right) => right.timestampMs - left.timestampMs),
      payoutDistribution: [...payoutDistributionByAsset.entries()]
        .map(([assetId, value]) => ({
          assetId,
          label: labels.get(assetId) ?? assetId,
          quantity: value.quantity.toString(),
          payoutCount: value.payoutCount,
          lastPayoutAt: new Date(value.lastPayoutMs).toISOString()
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      denominationOptions,
      apySeries,
      range: {
        from: new Date(effectiveFromMs).toISOString(),
        to: new Date(toMs).toISOString()
      },
      requestedGranularitySeconds,
      granularitySeconds: resolvedGranularitySeconds,
      overviewGranularity: resolvedGranularitySeconds,
      mixedGranularity: resolvedGranularitySeconds > requestedGranularitySeconds,
      coverage: {
        ledgerComplete,
        oldestLedgerAt: ledgerState.oldestAtMs === null
          ? null
          : new Date(ledgerState.oldestAtMs).toISOString(),
        message: ledgerComplete
          ? hasBalanceGap
            ? 'The complete imported ledger contains an Earn outflow without its opening allocation; that balance remains unknown until an exact account snapshot anchors it.'
            : 'Balances are reconstructed from the complete imported Kraken ledger and corrected by exact account snapshots.'
          : 'The imported Kraken ledger is incomplete; balances remain unknown until an exact account snapshot or allocation observation anchors them.'
      },
      apyCoverage: {
        available: apySeries.length > 0,
        oldestObservedAt: apyOldestAtMs === null ? null : new Date(apyOldestAtMs).toISOString(),
        providerBackfillAvailable: false,
        complete: strategyState.completeness === 'complete',
        message: apyOldestAtMs === null
          ? 'No Kraken Earn rate estimate has been observed yet. Kraken exposes current strategy APR estimates but no historical rate endpoint.'
          : `Rate history is observed locally from ${new Date(apyOldestAtMs).toISOString()}. Kraken exposes no historical Earn-rate endpoint, so dates before the first observation cannot be backfilled.`
      },
      series: [
        {
          id: 'kraken-earn-total',
          label: 'Earn total',
          points: [...valuesByTimestamp.entries()]
            .sort(([left], [right]) => left - right)
            .map(([timestampMs, value]) => {
              const quotes = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => [
                quoteCurrency,
                value.quotes.get(quoteCurrency)?.toString() ?? null
              ]));
              return {
                timestampMs,
                value: value.pricedAssets > 0 ? value.value.toString() : null,
                coveragePercent: assetIds.length === 0
                  ? '100'
                  : new Decimal(value.pricedAssets)
                    .dividedBy(assetIds.length)
                    .times(100)
                    .toString(),
                quotes,
                quantities: Object.fromEntries(
                  [...value.quantities.entries()].map(([assetId, quantity]) => [
                    assetId,
                    quantity.toString()
                  ])
                ),
                ...denominationsAt({ quoteValues: quotes, timestampMs })
              };
            })
        },
        ...[...valuesByAsset.entries()]
          .map(([assetId, values]) => ({
            id: `kraken-earn:${assetId}`,
            label: labels.get(assetId) ?? assetId,
            points: [...values.entries()]
              .sort(([left], [right]) => left - right)
              .map(([timestampMs, value]) => {
                const quotes = assetQuotes({ assetId, timestampMs, value });
                return {
                  timestampMs,
                  value: value.priced ? value.value.toString() : null,
                  coveragePercent: value.unpriced ? '0' : '100',
                  quotes,
                  quantities: {
                    [assetId]: value.quantity.toString()
                  },
                  ...denominationsAt({ quoteValues: quotes, timestampMs })
                };
              })
          }))
          .sort((left, right) => left.label.localeCompare(right.label))
      ],
      partial: !ledgerComplete || hasBalanceGap || [...valuesByAsset.values()].some((values) => (
        [...values.values()].some((value) => value.unpriced)
      ))
    };
  }

  async assetIds() {
    const snapshot = await this.db.one<{ id: string }>({
      sql: 'SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1'
    });
    if (!snapshot) return [];
    const rows = await this.db.query<{ canonical_asset_id: string }>({
      sql: `
        SELECT DISTINCT canonical_asset_id
        FROM kraken_snapshot_balances
        WHERE snapshot_id = ? AND canonical_asset_id IS NOT NULL
        ORDER BY canonical_asset_id
      `,
      parameters: [snapshot.id]
    });
    return rows.map((row) => row.canonical_asset_id);
  }

  async summary({
    quoteCurrencies
  }: {
    quoteCurrencies?: string[];
  } = {}) {
    const primaryCurrency = await this.primaryCurrency();
    const snapshot = await this.db.one<{
      captured_at_ms: number | string;
      total_value_currency: string | null;
      total_value: string | null;
      price_coverage: string;
    }>({
      sql: 'SELECT * FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1'
    });
    const [spot, earn, snapshotEarn, margin, coverage] = await Promise.all([
      this.db.one<{ count: number | string }>({
        sql: `
          SELECT COUNT(*) AS count FROM kraken_snapshot_balances
          WHERE category = 'spot'
            AND snapshot_id = (SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1)
        `
      }),
      this.db.one<{ count: number | string }>({ sql: 'SELECT COUNT(*) AS count FROM kraken_earn_allocations WHERE quantity != \'0\'' }),
      this.db.one<{ count: number | string }>({
        sql: `
          SELECT COUNT(*) AS count FROM kraken_snapshot_balances
          WHERE category = 'earn' AND quantity != '0'
            AND snapshot_id = (SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1)
        `
      }),
      this.db.one<{ count: number | string }>({ sql: 'SELECT COUNT(*) AS count FROM kraken_margin_positions WHERE status = \'open\'' }),
      this.db.one<{
        priced_count: number | string;
        total_count: number | string;
      }>({
        sql: `
          SELECT
            COALESCE(SUM(CASE WHEN priced = 1 AND quantity != '0' THEN 1 ELSE 0 END), 0) AS priced_count,
            COALESCE(SUM(CASE WHEN quantity != '0' THEN 1 ELSE 0 END), 0) AS total_count
          FROM kraken_snapshot_balances
          WHERE snapshot_id = (SELECT id FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1)
        `
      })
    ]);
    const summaryCurrencies = [...new Set([
      primaryCurrency,
      ...(quoteCurrencies ?? await this.configuredTooltipCurrencies())
    ].map((item) => item.toUpperCase()))];
    const summarySeries = snapshot
      ? await this.series({
          fromMs: Number(snapshot.captured_at_ms),
          toMs: Number(snapshot.captured_at_ms),
          quoteCurrencies: summaryCurrencies
        })
      : null;
    const latestTotal = summarySeries?.series
      .find((item) => item.id === 'kraken-total')
      ?.points.at(-1);
    const values = Object.fromEntries(summaryCurrencies.map((currency) => [
      currency,
      latestTotal?.quotes?.[currency]
        ?? (currency === snapshot?.total_value_currency ? snapshot.total_value : null)
    ]));
    const stale = snapshot
      ? Number(snapshot.captured_at_ms) < Date.now() - this.runtime.config.sync.staleAfterMinutes * 60_000
      : false;
    return {
      totalCurrentValue: values[primaryCurrency]
        ?? (snapshot?.total_value_currency === primaryCurrency ? snapshot.total_value : null)
        ?? '0',
      currency: primaryCurrency,
      values,
      pricedValueCoveragePercent: snapshot?.price_coverage ?? '0',
      pricedAssetCount: Number(coverage?.priced_count ?? 0),
      totalAssetCount: Number(coverage?.total_count ?? 0),
      latestSuccessfulSync: snapshot ? new Date(Number(snapshot.captured_at_ms)).toISOString() : null,
      stale,
      sections: {
        spot: Number(spot?.count ?? 0) > 0,
        earn: Number(earn?.count ?? 0) > 0 || Number(snapshotEarn?.count ?? 0) > 0,
        margin: Number(margin?.count ?? 0) > 0,
        futures: false
      }
    };
  }

  async activity({ limit = 200 }: { limit?: number } = {}) {
    const trades = await this.db.query<Record<string, unknown>>({
      sql: 'SELECT * FROM kraken_trades ORDER BY occurred_at_ms DESC, kraken_id LIMIT ?',
      parameters: [Math.min(500, Math.max(1, limit))]
    });
    const ledgers = await this.db.query<Record<string, unknown>>({
      sql: 'SELECT * FROM kraken_ledgers ORDER BY occurred_at_ms DESC, kraken_id LIMIT ?',
      parameters: [Math.min(500, Math.max(1, limit))]
    });
    return { trades, ledgers };
  }

  private async historicalPrice({
    assetId,
    occurredAtMs,
    quoteCurrency
  }: {
    assetId: string;
    occurredAtMs: number;
    quoteCurrency: string;
  }) {
    if (assetId === quoteCurrency.toLowerCase()) return '1';
    const rows = await this.db.query<{
      provider: string;
      close_value: string;
      data_kind: 'native' | 'derived';
    }>({
      sql: `
        SELECT provider, close_value, data_kind
        FROM market_points
        WHERE canonical_asset_id = ? AND quote_currency = ?
          AND bucket_start_ms = (
            SELECT MAX(bucket_start_ms)
            FROM market_points
            WHERE canonical_asset_id = ? AND quote_currency = ?
              AND bucket_start_ms <= ?
              AND bucket_start_ms >= ?
          )
        ORDER BY provider, data_kind DESC
      `,
      parameters: [assetId, quoteCurrency, assetId, quoteCurrency, occurredAtMs, occurredAtMs - 7 * 24 * 60 * 60_000]
    });
    const byProvider = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const existing = byProvider.get(row.provider);
      if (!existing || (row.data_kind === 'native' && existing.data_kind !== 'native')) {
        byProvider.set(row.provider, row);
      }
    }
    return combinePriceObservations({
      observations: [...byProvider.values()].map((row) => ({
        provider: row.provider,
        value: row.close_value,
        dataKind: row.data_kind
      })),
      disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
    }).value;
  }

  async pnl({
    method
  }: {
    method: CostBasisMethod;
  }) {
    const currency = await this.primaryCurrency();
    const trades = await this.db.query<{
      kraken_id: string;
      asset_in_id: string | null;
      asset_out_id: string | null;
      side: string;
      occurred_at_ms: number | string;
      quantity: string;
      pair_raw: string;
      cost: string | null;
      fee: string | null;
    }>({
      sql: 'SELECT * FROM kraken_trades ORDER BY occurred_at_ms, kraken_id'
    });
    const ledgers = await this.db.query<{
      kraken_id: string;
      canonical_asset_id: string | null;
      event_type: string;
      occurred_at_ms: number | string;
      amount: string;
      fee: string | null;
      transfer_confidence: string | null;
    }>({
      sql: `
        SELECT kraken_ledgers.*, (
          SELECT confidence
          FROM internal_transfer_matches
          WHERE internal_transfer_matches.kraken_ledger_id = kraken_ledgers.id
            AND internal_transfer_matches.confidence = 'exact'
          ORDER BY internal_transfer_matches.created_at_ms DESC
          LIMIT 1
        ) AS transfer_confidence
        FROM kraken_ledgers
        WHERE event_type IN ('deposit', 'withdrawal', 'staking', 'earn', 'reward')
        ORDER BY occurred_at_ms, kraken_id
      `
    });
    const events: BasisEvent[] = [];
    const historicalPriceCache = new Map<string, string | null>();
    let estimatedHistoricalValuations = 0;
    let unavailableHistoricalValuations = 0;
    let skippedMalformedTrades = 0;
    const historicalPrice = async ({ assetId, occurredAtMs }: { assetId: string; occurredAtMs: number }) => {
      const key = `${assetId}:${currency}:${Math.floor(occurredAtMs / 300_000)}`;
      if (!historicalPriceCache.has(key)) {
        historicalPriceCache.set(key, await this.historicalPrice({
          assetId,
          occurredAtMs,
          quoteCurrency: currency
        }));
      }
      return historicalPriceCache.get(key) ?? null;
    };
    for (const trade of trades) {
      const assetId = trade.side === 'buy' ? trade.asset_in_id : trade.asset_out_id;
      if (!assetId) {
        skippedMalformedTrades += 1;
        continue;
      }
      const occurredAtMs = Number(trade.occurred_at_ms);
      const quantity = new Decimal(trade.quantity).abs();
      const quoteAssetId = parsePairAssets({ pair: trade.pair_raw }).quoteAssetId;
      let valueCad = quoteAssetId === currency.toLowerCase() ? trade.cost : null;
      if (quoteAssetId !== currency.toLowerCase()) {
        const price = await historicalPrice({ assetId, occurredAtMs });
        valueCad = price === null ? null : quantity.times(price).toString();
        if (valueCad === null) unavailableHistoricalValuations += 1;
        else estimatedHistoricalValuations += 1;
      }
      const feeCad = quoteAssetId === currency.toLowerCase()
        ? trade.fee
        : valueCad !== null && trade.cost !== null && trade.fee !== null && !new Decimal(trade.cost).isZero()
          ? new Decimal(trade.fee).times(valueCad).dividedBy(trade.cost).toString()
          : null;
      events.push({
        id: trade.kraken_id,
        assetId,
        occurredAtMs,
        type: trade.side === 'buy' ? 'acquisition' : 'disposition',
        quantity: quantity.toString(),
        valueCad,
        feeCad
      });
    }
    for (const ledger of ledgers) {
      if (!ledger.canonical_asset_id) continue;
      const occurredAtMs = Number(ledger.occurred_at_ms);
      const quantity = new Decimal(ledger.amount).abs();
      const reward = ['staking', 'earn', 'reward'].includes(ledger.event_type);
      const type: BasisEvent['type'] = ledger.event_type === 'withdrawal'
        ? 'internal_out'
        : ledger.transfer_confidence === 'exact'
          ? 'internal_in'
          : reward
            ? 'reward'
            : 'acquisition';
      let valueCad: string | null = null;
      if (reward) {
        const price = await historicalPrice({
          assetId: ledger.canonical_asset_id,
          occurredAtMs
        });
        valueCad = price === null ? null : quantity.times(price).toString();
        if (valueCad === null) unavailableHistoricalValuations += 1;
        else estimatedHistoricalValuations += 1;
      }
      events.push({
        id: ledger.kraken_id,
        assetId: ledger.canonical_asset_id,
        occurredAtMs,
        type,
        quantity: quantity.toString(),
        valueCad,
        feeCad: null
      });
    }
    const calculation = calculateCostBasis({ events, method });
    const sourceHash = createHash('sha256').update(JSON.stringify(events)).digest('hex');
    const realisedKnown = Decimal.sum(
      0,
      ...calculation.dispositions
        .filter((disposition) => disposition.realisedPnlCad !== null)
        .map((disposition) => disposition.realisedPnlCad!)
    ).toString();
    let calculationRun = await this.db.one<{ id: string }>({
      sql: `
        SELECT id FROM calculation_runs
        WHERE method = ? AND currency = ? AND source_hash = ? AND status = 'complete'
        ORDER BY completed_at_ms DESC
        LIMIT 1
      `,
      parameters: [method, currency, sourceHash]
    });
    if (!calculationRun) {
      const calculationRunId = createId({ prefix: 'calc' });
      const now = Date.now();
      await this.db.transaction({
        task: async (executor) => {
          await executor.run({
            sql: `
              INSERT INTO calculation_runs(
                id, method, currency, source_hash, status, realised_pnl,
                unrealised_pnl, basis_coverage_percent, warnings_json,
                started_at_ms, completed_at_ms
              ) VALUES (?, ?, ?, ?, 'complete', ?, NULL, ?, ?, ?, ?)
            `,
            parameters: [
              calculationRunId,
              method,
              currency,
              sourceHash,
              realisedKnown,
              calculation.basisCoveragePercent,
              JSON.stringify({
                estimatedHistoricalValuations,
                unavailableHistoricalValuations,
                skippedMalformedTrades
              }),
              now,
              now
            ]
          });
          for (const lot of calculation.lots) {
            await executor.run({
              sql: `
                INSERT INTO cost_basis_lots(
                  id, calculation_run_id, method, canonical_asset_id, acquired_at_ms,
                  original_quantity, remaining_quantity, basis_currency, basis_amount,
                  basis_known, source_type, source_id
                ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'calculation-output', ?)
              `,
              parameters: [
                createId({ prefix: 'lot' }),
                calculationRunId,
                method,
                lot.assetId,
                lot.remainingQuantity,
                lot.remainingQuantity,
                currency,
                lot.basisCad,
                lot.basisKnown ? 1 : 0,
                lot.id
              ]
            });
          }
        }
      });
      calculationRun = { id: calculationRunId };
    }
    const dispositions = calculation.dispositions.map((disposition) => ({
      eventId: disposition.eventId,
      quantity: disposition.quantity,
      proceeds: disposition.proceedsCad,
      knownBasis: disposition.knownBasisCad,
      unknownQuantity: disposition.unknownQuantity,
      realisedPnl: disposition.realisedPnlCad,
      consumedLots: disposition.consumedLots.map((lot) => ({
        lotId: lot.lotId,
        quantity: lot.quantity,
        basis: lot.basisCad
      }))
    }));
    const lots = calculation.lots.map((lot) => ({
      id: lot.id,
      assetId: lot.assetId,
      remainingQuantity: lot.remainingQuantity,
      basis: lot.basisCad,
      basisKnown: lot.basisKnown
    }));
    return {
      method: calculation.method,
      currency,
      dispositions,
      lots,
      basisCoveragePercent: calculation.basisCoveragePercent,
      calculationRunId: calculationRun.id,
      realisedPnl: realisedKnown,
      sourceHash,
      valuationCoverage: {
        estimatedHistoricalValuations,
        unavailableHistoricalValuations,
        skippedMalformedTrades
      },
      disclaimer: 'Informational portfolio estimate only; not tax or accounting advice.',
      incompleteBasis: new Decimal(calculation.basisCoveragePercent).lessThan(100)
        || calculation.dispositions.some((disposition) => new Decimal(disposition.unknownQuantity).greaterThan(0))
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
    const oldest = fromMs === 0
      ? await this.db.one<{ oldest: number | string | null }>({
          sql: 'SELECT MIN(captured_at_ms) AS oldest FROM kraken_snapshots'
        })
      : null;
    const effectiveFromMs = fromMs === 0
      ? Number(oldest?.oldest ?? toMs)
      : fromMs;
    const requestedGranularitySeconds = granularitySeconds === 'auto'
      ? resolveAutoGranularity({ fromMs: effectiveFromMs, toMs })
      : granularitySeconds;
    const seriesCountRow = await this.db.one<{ asset_count: number | string }>({
      sql: `
        SELECT COUNT(DISTINCT COALESCE(balance.canonical_asset_id, balance.asset_raw)) AS asset_count
        FROM kraken_snapshot_balances AS balance
        JOIN kraken_snapshots AS snapshot ON snapshot.id = balance.snapshot_id
        WHERE snapshot.captured_at_ms >= ? AND snapshot.captured_at_ms <= ?
      `,
      parameters: [effectiveFromMs, toMs]
    });
    const resolvedGranularitySeconds = boundedOverviewGranularity({
      requestedGranularity: Math.max(300, requestedGranularitySeconds),
      fromMs: effectiveFromMs,
      toMs,
      seriesCount: Math.max(1, Number(seriesCountRow?.asset_count ?? 0) + 1)
    });
    const bucketMs = resolvedGranularitySeconds * 1_000;
    const snapshots = await this.db.query<{
      captured_at_ms: number | string;
      total_value_currency: string | null;
      total_value: string | null;
      price_coverage: string;
    }>({
      sql: `
        WITH ranked_snapshots AS (
          SELECT captured_at_ms, total_value_currency, total_value,
                 price_coverage,
                 ROW_NUMBER() OVER (
                   PARTITION BY CAST(captured_at_ms / ? AS INTEGER)
                   ORDER BY captured_at_ms DESC
                 ) AS bucket_rank
          FROM kraken_snapshots
          WHERE captured_at_ms >= ? AND captured_at_ms <= ?
        )
        SELECT captured_at_ms, total_value_currency, total_value, price_coverage
        FROM ranked_snapshots
        WHERE bucket_rank = 1
        ORDER BY captured_at_ms
      `,
      parameters: [bucketMs, effectiveFromMs, toMs]
    });
    const balances = await this.db.query<{
      captured_at_ms: number | string;
      asset_raw: string;
      canonical_asset_id: string | null;
      quantity: string;
      value_amount: string | null;
      priced: number | string;
    }>({
      sql: `
        WITH ranked_snapshots AS (
          SELECT id, captured_at_ms,
                 ROW_NUMBER() OVER (
                   PARTITION BY CAST(captured_at_ms / ? AS INTEGER)
                   ORDER BY captured_at_ms DESC
                 ) AS bucket_rank
          FROM kraken_snapshots
          WHERE captured_at_ms >= ? AND captured_at_ms <= ?
        )
        SELECT snapshot.captured_at_ms, balance.asset_raw,
               balance.canonical_asset_id, balance.quantity,
               balance.value_amount, balance.priced
        FROM ranked_snapshots AS snapshot
        JOIN kraken_snapshot_balances AS balance ON balance.snapshot_id = snapshot.id
        WHERE snapshot.bucket_rank = 1
        ORDER BY snapshot.captured_at_ms, balance.canonical_asset_id, balance.asset_raw
      `,
      parameters: [bucketMs, effectiveFromMs, toMs]
    });
    const assetIds = [...new Set(
      balances.map((balance) => canonicalKrakenAsset({ raw: balance.asset_raw })).filter(Boolean)
    )];
    const catalogRows = assetIds.length === 0
      ? []
      : await this.db.query<{ canonical_id: string; symbol: string; name: string }>({
          sql: `
            SELECT canonical_id, symbol, name
            FROM asset_catalog
            WHERE canonical_id IN (${assetIds.map(() => '?').join(', ')})
          `,
          parameters: assetIds
        });
    const labels = new Map(catalogRows.map((row) => [
      row.canonical_id,
      `${row.symbol} · ${row.name}`
    ]));
    const [defaultCurrency, configuredCurrencies, denominationOptions] = await Promise.all([
      this.primaryCurrency(),
      quoteCurrencies === undefined
        ? this.configuredTooltipCurrencies()
        : Promise.resolve(quoteCurrencies),
      enabledChartDenominations({ db: this.db })
    ]);
    const currency = defaultCurrency;
    const resolvedQuoteCurrencies = [...new Set([
      currency,
      'USD',
      ...configuredCurrencies.map((configured) => configured.toUpperCase())
        .filter((configured) => /^[A-Z]{3}$/.test(configured))
    ])];
    const quoteAt = await this.historicalQuoteLookup({
      assetIds: [...new Set([
        ...assetIds,
        ...denominationOptions.map((option) => option.id)
      ])],
      quoteCurrencies: resolvedQuoteCurrencies,
      fromMs: effectiveFromMs,
      toMs,
      queryGranularitySeconds: resolvedGranularitySeconds
    });
    const rawLabels = new Map<string, string>();
    const valuesByAsset = new Map<string, Map<number, {
      quantity: Decimal;
      value: Decimal;
      priced: boolean;
      unpriced: boolean;
    }>>();
    for (const balance of balances) {
      // Normalize from Kraken's raw code on every read. This repairs historical rows
      // written before suffix/alias mappings were complete without rewriting evidence.
      const assetId = canonicalKrakenAsset({ raw: balance.asset_raw });
      rawLabels.set(assetId, balance.asset_raw);
      const timestampMs = Number(balance.captured_at_ms);
      const values = valuesByAsset.get(assetId) ?? new Map();
      const current = values.get(timestampMs) ?? {
        quantity: new Decimal(0),
        value: new Decimal(0),
        priced: false,
        unpriced: false
      };
      current.quantity = current.quantity.plus(balance.quantity);
      if (Boolean(Number(balance.priced)) && balance.value_amount !== null) {
        current.value = current.value.plus(balance.value_amount);
        current.priced = true;
      } else {
        current.unpriced = true;
      }
      values.set(timestampMs, current);
      valuesByAsset.set(assetId, values);
    }
    const assetQuotes = ({
      assetId,
      timestampMs,
      value
    }: {
      assetId: string;
      timestampMs: number;
      value: {
        quantity: Decimal;
        value: Decimal;
        priced: boolean;
      };
    }) => Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => {
      const price = quoteAt({ assetId, quoteCurrency, timestampMs });
      return [
        quoteCurrency,
        price !== null
          ? value.quantity.times(price).toString()
          : quoteCurrency === currency && value.priced
            ? value.value.toString()
            : null
      ];
    }));
    const denominationsAt = ({
      quoteValues,
      timestampMs
    }: {
      quoteValues: Record<string, string | null | undefined>;
      timestampMs: number;
    }) => chartDenominationsAt({
      denominationOptions,
      quoteValues,
      primaryCurrency: currency,
      timestampMs,
      priceAt: quoteAt
    });
    const totalQuotesByTimestamp = new Map<number, Map<string, Decimal>>();
    const totalQuantitiesByTimestamp = new Map<number, Map<string, Decimal>>();
    for (const [assetId, values] of valuesByAsset) {
      for (const [timestampMs, value] of values) {
        const totals = totalQuotesByTimestamp.get(timestampMs) ?? new Map<string, Decimal>();
        for (const [quoteCurrency, quoteValue] of Object.entries(assetQuotes({
          assetId,
          timestampMs,
          value
        }))) {
          if (quoteValue === null) continue;
          totals.set(
            quoteCurrency,
            (totals.get(quoteCurrency) ?? new Decimal(0)).plus(quoteValue)
          );
        }
        totalQuotesByTimestamp.set(timestampMs, totals);
        const quantities = totalQuantitiesByTimestamp.get(timestampMs) ?? new Map<string, Decimal>();
        quantities.set(
          assetId,
          (quantities.get(assetId) ?? new Decimal(0)).plus(value.quantity)
        );
        totalQuantitiesByTimestamp.set(timestampMs, quantities);
      }
    }
    const events = await krakenEvents({
      db: this.db,
      fromMs: effectiveFromMs,
      toMs
    });
    return {
      events,
      denominationOptions,
      requestedGranularitySeconds,
      granularitySeconds: resolvedGranularitySeconds,
      overviewGranularity: resolvedGranularitySeconds,
      mixedGranularity: resolvedGranularitySeconds > requestedGranularitySeconds,
      series: [
        {
          id: 'kraken-total',
          label: 'Kraken total',
          points: snapshots.map((snapshot) => {
            const timestampMs = Number(snapshot.captured_at_ms);
            const quotes = Object.fromEntries(resolvedQuoteCurrencies.map((quoteCurrency) => [
              quoteCurrency,
              totalQuotesByTimestamp.get(timestampMs)?.get(quoteCurrency)?.toString()
                ?? (quoteCurrency === currency ? snapshot.total_value : null)
            ]));
            const primaryValue = quotes[currency] ?? snapshot.total_value;
            return {
              timestampMs,
              value: primaryValue,
              coveragePercent: snapshot.price_coverage,
              quotes,
              quantities: Object.fromEntries(
                [...(totalQuantitiesByTimestamp.get(timestampMs) ?? new Map()).entries()]
                  .map(([assetId, quantity]) => [assetId, quantity.toString()])
              ),
              ...denominationsAt({ quoteValues: quotes, timestampMs })
            };
          })
        },
        ...[...valuesByAsset.entries()]
          .map(([assetId, values]) => ({
            id: `kraken-asset:${assetId}`,
            label: labels.get(assetId) ?? rawLabels.get(assetId) ?? assetId,
            points: [...values.entries()]
              .sort(([left], [right]) => left - right)
              .map(([timestampMs, value]) => {
                const quotes = assetQuotes({ assetId, timestampMs, value });
                const primaryValue = quotes[currency] ?? null;
                return {
                  timestampMs,
                  value: primaryValue,
                  coveragePercent: primaryValue === null ? '0' : '100',
                  quotes,
                  quantities: {
                    [assetId]: value.quantity.toString()
                  },
                  ...denominationsAt({ quoteValues: quotes, timestampMs })
                };
              })
          }))
          .sort((left, right) => left.label.localeCompare(right.label))
      ],
      partial: snapshots.some((snapshot) => new Decimal(snapshot.price_coverage).lessThan(100))
    };
  }
}

export const krakenServiceInternals = {
  canonicalKrakenAsset,
  parsePairAssets
};

export const asKrakenClientContract = ({
  client
}: {
  client: KrakenReadOnlyClient;
}): KrakenClientContract => client;
