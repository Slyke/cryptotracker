import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import type { AddressService } from './addresses.js';
import type { MarketService } from './market.js';
import type { KrakenService } from './kraken.js';

interface CategoryDefinition {
  category: string;
  tables: string[];
  timeColumn: string | null;
}

const categories: CategoryDefinition[] = [
  {
    category: 'market',
    tables: ['market_points', 'market_sync_cursors', 'asset_provider_mappings', 'asset_lifecycle_events'],
    timeColumn: 'retrieved_at_ms'
  },
  {
    category: 'addresses',
    tables: ['tracked_addresses', 'chain_transactions', 'address_balance_events', 'address_balance_points'],
    timeColumn: 'occurred_at_ms'
  },
  {
    category: 'portfolio',
    tables: ['portfolio_snapshots'],
    timeColumn: 'captured_at_ms'
  },
  {
    category: 'kraken',
    tables: [
      'kraken_trades',
      'kraken_ledgers',
      'kraken_snapshots',
      'kraken_snapshot_balances',
      'kraken_margin_positions',
      'kraken_earn_allocations',
      'kraken_earn_strategy_rates',
      'kraken_account_observations'
    ],
    timeColumn: 'occurred_at_ms'
  },
  {
    category: 'calculations',
    tables: ['internal_transfer_matches', 'cost_basis_lots', 'calculation_runs'],
    timeColumn: 'created_at_ms'
  },
  {
    category: 'operations',
    tables: ['jobs', 'audit_log', 'application_exports'],
    timeColumn: 'created_at_ms'
  }
];

const safeTable = /^[a-z][a-z0-9_]*$/;

export class DiagnosticsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly market: MarketService,
    private readonly addresses: AddressService,
    private readonly kraken: KrakenService
  ) {}

  private async countTable({ table }: { table: string }) {
    if (!safeTable.test(table)) return 0;
    const row = await this.db.one<{ count: number | string }>({
      sql: `SELECT COUNT(*) AS count FROM ${table}`
    });
    return Number(row?.count ?? 0);
  }

  async storage() {
    const databaseBytes = await this.db.estimateSizeBytes();
    const allTables = await this.db.listTables();
    const tableCounts = Object.fromEntries(
      await Promise.all(allTables.map(async (table) => [table, await this.countTable({ table })] as const))
    );
    const totalRows = Object.values(tableCounts).reduce((total, count) => total + count, 0);
    const categoryRows = categories.map((definition) => {
      const rowCount = definition.tables.reduce((total, table) => total + (tableCounts[table] ?? 0), 0);
      return {
        category: definition.category,
        rowCount,
        estimatedBytes: totalRows === 0 ? 0 : Math.round(databaseBytes * (rowCount / totalRows)),
        tables: definition.tables.map((table) => ({
          table,
          rowCount: tableCounts[table] ?? 0
        }))
      };
    });
    const rangeQueries = [
      ['market', 'market_points', 'bucket_start_ms'],
      ['portfolio', 'portfolio_snapshots', 'captured_at_ms'],
      ['addresses', 'address_balance_events', 'occurred_at_ms'],
      ['kraken', 'kraken_snapshots', 'captured_at_ms'],
      ['audit', 'audit_log', 'occurred_at_ms']
    ] as const;
    const retainedRanges = [];
    for (const [category, table, column] of rangeQueries) {
      const row = await this.db.one<{ oldest: number | string | null; newest: number | string | null }>({
        sql: `SELECT MIN(${column}) AS oldest, MAX(${column}) AS newest FROM ${table}`
      });
      retainedRanges.push({
        category,
        oldest: row?.oldest === null || row?.oldest === undefined ? null : new Date(Number(row.oldest)).toISOString(),
        newest: row?.newest === null || row?.newest === undefined ? null : new Date(Number(row.newest)).toISOString()
      });
    }
    return {
      databaseKind: this.db.kind,
      databaseEstimatedBytes: databaseBytes,
      totalRows,
      categories: categoryRows,
      retainedRanges,
      retention: {
        policy: 'user-configurable',
        default: 'forever',
        automaticallyPrunedTables: [
          'market_points',
          'address_balance_points',
          'kraken_snapshots',
          'kraken_account_observations',
          'portfolio_snapshots'
        ],
        protectedTables: ['chain_transactions', 'address_balance_events', 'kraken_trades', 'kraken_ledgers', 'cost_basis_lots', 'calculation_runs'],
        destructiveDownsampling: false,
        explanation: 'Historical market points and derived portfolio snapshots follow the user retention window. Transaction and activity records needed for balances and cost basis are not automatically pruned.'
      }
    };
  }

  async providers() {
    return {
      market: this.market.providerStatus(),
      chains: this.addresses.providerStatus(),
      kraken: await this.kraken.status(),
      disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
    };
  }

  async syncProgress({
    failedQuery = '',
    failedType = '',
    failedPage = 1,
    failedPageSize = 10
  }: {
    failedQuery?: string;
    failedType?: string;
    failedPage?: number;
    failedPageSize?: number;
  } = {}) {
    type JobRow = {
      id: string;
      job_type: string;
      resource_key: string;
      status: string;
      progress_current: number | string;
      progress_total: number | string | null;
      cursor_json: string;
      payload_json: string;
      last_error_json: string | null;
      created_at_ms: number | string;
      updated_at_ms: number | string;
      completed_at_ms: number | string | null;
    };
    const normalizedFailedQuery = failedQuery.trim().toLowerCase();
    const normalizedFailedType = failedType.trim();
    const safeFailedPageSize = [10, 20, 50, 100].includes(failedPageSize)
      ? failedPageSize
      : 10;
    const failedWhere = [
      'status = \'failed\'',
      `(
        job_type <> 'market.sync'
        OR EXISTS (
          SELECT 1
          FROM watched_assets
          WHERE watched_assets.enabled = 1
            AND jobs.resource_key LIKE '%:' || watched_assets.canonical_id || ':%'
        )
      )`
    ];
    const failedParameters: Array<string | number | null> = [];
    if (normalizedFailedType) {
      failedWhere.push('job_type = ?');
      failedParameters.push(normalizedFailedType);
    }
    if (normalizedFailedQuery) {
      const pattern = `%${normalizedFailedQuery}%`;
      failedWhere.push(`(
        LOWER(job_type) LIKE ?
        OR LOWER(resource_key) LIKE ?
        OR LOWER(COALESCE(last_error_json, '')) LIKE ?
      )`);
      failedParameters.push(pattern, pattern, pattern);
    }
    const failedWhereSql = failedWhere.join(' AND ');
    const failedCount = await this.db.one<{ count: number | string }>({
      sql: `SELECT COUNT(*) AS count FROM jobs WHERE ${failedWhereSql}`,
      parameters: failedParameters
    });
    const failedTotal = Number(failedCount?.count ?? 0);
    const failedPageCount = Math.max(1, Math.ceil(failedTotal / safeFailedPageSize));
    const safeFailedPage = Math.min(Math.max(1, failedPage), failedPageCount);
    const failedOffset = (safeFailedPage - 1) * safeFailedPageSize;
    const [jobs, failedJobs, failedJobTypes, marketCursors, krakenCursors, enabledAssets] = await Promise.all([
      this.db.query<{
        id: string;
        job_type: string;
        resource_key: string;
        status: string;
        progress_current: number | string;
        progress_total: number | string | null;
        cursor_json: string;
        payload_json: string;
        last_error_json: string | null;
        created_at_ms: number | string;
        updated_at_ms: number | string;
        completed_at_ms: number | string | null;
      }>({
        sql: `
          SELECT id, job_type, resource_key, status, progress_current, progress_total,
                 cursor_json, payload_json, last_error_json, created_at_ms,
                 updated_at_ms, completed_at_ms
          FROM jobs
          WHERE status IN ('queued', 'running', 'retry')
             OR (status = 'completed' AND completed_at_ms >= ?)
          ORDER BY
            CASE status
              WHEN 'running' THEN 0
              WHEN 'queued' THEN 1
              WHEN 'retry' THEN 2
              ELSE 3
            END,
            updated_at_ms DESC
          LIMIT 1000
        `,
        parameters: [Date.now() - 24 * 60 * 60_000]
      }),
      this.db.query<JobRow>({
        sql: `
          SELECT id, job_type, resource_key, status, progress_current, progress_total,
                 cursor_json, payload_json, last_error_json, created_at_ms,
                 updated_at_ms, completed_at_ms
          FROM jobs
          WHERE ${failedWhereSql}
          ORDER BY updated_at_ms DESC, id DESC
          LIMIT ? OFFSET ?
        `,
        parameters: [...failedParameters, safeFailedPageSize, failedOffset]
      }),
      this.db.query<{ job_type: string }>({
        sql: `
          SELECT DISTINCT job_type
          FROM jobs
          WHERE status = 'failed'
          ORDER BY job_type
        `
      }),
      this.db.query<{
        provider: string;
        canonical_asset_id: string;
        quote_currency: string;
        granularity_seconds: number | string;
        oldest_at_ms: number | string | null;
        newest_at_ms: number | string | null;
        completeness: string;
        last_success_at_ms: number | string | null;
        updated_at_ms: number | string;
      }>({
        sql: `
          SELECT cursor.provider, cursor.canonical_asset_id, cursor.quote_currency,
                 cursor.granularity_seconds, cursor.oldest_at_ms, cursor.newest_at_ms,
                 cursor.completeness, cursor.last_success_at_ms, cursor.updated_at_ms
          FROM market_sync_cursors AS cursor
          INNER JOIN watched_assets AS watched
            ON watched.canonical_id = cursor.canonical_asset_id
          WHERE watched.enabled = 1
          ORDER BY cursor.updated_at_ms DESC
          LIMIT 500
        `
      }),
      this.db.query<{
        endpoint: string;
        cursor_json: string;
        completeness: string;
        oldest_at_ms: number | string | null;
        newest_at_ms: number | string | null;
        last_success_at_ms: number | string | null;
        updated_at_ms: number | string;
      }>({
        sql: 'SELECT * FROM kraken_sync_cursors ORDER BY endpoint'
      }),
      this.db.query<{ canonical_id: string }>({
        sql: 'SELECT canonical_id FROM watched_assets WHERE enabled = 1'
      })
    ]);
    const parseJson = (value: string | null) => {
      try {
        return JSON.parse(value ?? '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const iso = (value: number | string | null) => (
      value === null ? null : new Date(Number(value)).toISOString()
    );
    const enabledAssetIds = new Set(enabledAssets.map((asset) => asset.canonical_id));
    const jobIsVisible = (job: JobRow) => {
      if (job.job_type !== 'market.sync') return true;
      const payload = parseJson(job.payload_json);
      return typeof payload.canonicalAssetId === 'string' && enabledAssetIds.has(payload.canonicalAssetId);
    };
    const visibleJobs = jobs.filter(jobIsVisible);
    const mapJob = (job: JobRow) => {
      const current = Number(job.progress_current);
      const total = job.progress_total === null ? null : Number(job.progress_total);
      const cursor = parseJson(job.cursor_json);
      const payload = parseJson(job.payload_json);
      return {
        id: job.id,
        type: job.job_type,
        target: job.resource_key,
        status: job.status,
        current,
        total,
        percent: total && total > 0 ? Math.min(100, (current / total) * 100) : null,
        requestedFrom: typeof payload.fromMs === 'number' ? iso(payload.fromMs) : null,
        requestedTo: typeof payload.toMs === 'number' ? iso(payload.toMs) : null,
        processedThrough: typeof cursor.toMs === 'number' ? iso(cursor.toMs) : null,
        cursor,
        error: parseJson(job.last_error_json),
        createdAt: iso(job.created_at_ms),
        updatedAt: iso(job.updated_at_ms),
        completedAt: iso(job.completed_at_ms)
      };
    };
    return {
      generatedAt: new Date().toISOString(),
      jobs: visibleJobs.map(mapJob),
      failedJobs: {
        items: failedJobs.map(mapJob),
        total: failedTotal,
        page: safeFailedPage,
        pageSize: safeFailedPageSize,
        pageCount: failedPageCount,
        types: failedJobTypes.map((row) => row.job_type)
      },
      market: marketCursors.map((cursor) => ({
        provider: cursor.provider,
        asset: cursor.canonical_asset_id,
        currency: cursor.quote_currency,
        granularitySeconds: Number(cursor.granularity_seconds),
        oldest: iso(cursor.oldest_at_ms),
        newest: iso(cursor.newest_at_ms),
        completeness: cursor.completeness,
        lastSuccessfulSync: iso(cursor.last_success_at_ms),
        updatedAt: iso(cursor.updated_at_ms)
      })),
      kraken: krakenCursors.map((cursor) => ({
        endpoint: cursor.endpoint,
        completeness: cursor.completeness,
        oldest: iso(cursor.oldest_at_ms),
        newest: iso(cursor.newest_at_ms),
        lastSuccessfulSync: iso(cursor.last_success_at_ms),
        updatedAt: iso(cursor.updated_at_ms),
        cursor: parseJson(cursor.cursor_json)
      }))
    };
  }

  async queue() {
    const row = await this.db.one<{
      depth: number | string;
      oldest: number | string | null;
    }>({
      sql: `
        SELECT COUNT(*) AS depth, MIN(created_at_ms) AS oldest
        FROM jobs
        WHERE status IN ('queued', 'running', 'retry')
      `
    });
    return {
      depth: Number(row?.depth ?? 0),
      oldestPendingAt: row?.oldest ? new Date(Number(row.oldest)).toISOString() : null
    };
  }
}
