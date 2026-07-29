import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import type { BuildInfo } from '../build-info.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { AppError } from '../errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { createId } from '../utils/ids.js';

const publicTables = [
  'user_settings',
  'watched_assets',
  'selected_quote_currencies',
  'asset_provider_mappings',
  'asset_lifecycle_events',
  'market_points',
  'market_sync_cursors',
  'tracked_addresses',
  'address_asset_selections',
  'address_sync_state',
  'chain_transactions',
  'address_balance_events',
  'address_balance_points',
  'kraken_trades',
  'kraken_ledgers',
  'kraken_snapshots',
  'kraken_snapshot_balances',
  'kraken_margin_positions',
  'kraken_earn_allocations',
  'kraken_earn_strategy_rates',
  'kraken_account_observations',
  'kraken_sync_cursors',
  'portfolio_snapshots',
  'internal_transfer_matches',
  'cost_basis_lots',
  'calculation_runs',
  'jobs',
  'audit_log'
] as const;

interface ExportRow {
  id: string;
  status: string;
  artifact_path: string | null;
  manifest_json: string | null;
  bytes_written: number | string | null;
  checksum_sha256: string | null;
  created_at_ms: number | string;
  completed_at_ms: number | string | null;
  expires_at_ms: number | string | null;
  last_error_json: string | null;
}

const streamTableJsonl = async ({
  db,
  table,
  output
}: {
  db: AppDatabase;
  table: string;
  output: Writable;
}) => {
  const checksum = createHash('sha256');
  let offset = 0;
  let rowCount = 0;
  while (true) {
    const rows = await db.query<Record<string, unknown>>({
      sql: `SELECT * FROM ${table} ORDER BY 1 LIMIT ? OFFSET ?`,
      parameters: [500, offset]
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      checksum.update(line);
      rowCount += 1;
      if (!output.write(line)) await once(output, 'drain');
    }
    offset += rows.length;
  }
  const finished = once(output, 'finish');
  output.end();
  await finished;
  return {
    rowCount,
    sha256: checksum.digest('hex')
  };
};

export class ApplicationExportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly jobs: JobQueue,
    private readonly buildInfo: BuildInfo
  ) {}

  async create() {
    const id = createId({ prefix: 'export' });
    const now = Date.now();
    await this.db.run({
      sql: `
        INSERT INTO application_exports(id, status, created_at_ms)
        VALUES (?, 'queued', ?)
      `,
      parameters: [id, now]
    });
    const queued = await this.jobs.enqueue({
      jobType: 'application.export',
      resourceKey: `export:${id}`,
      idempotencyKey: `application-export:${id}`,
      priority: 50,
      payload: { exportId: id }
    });
    return {
      id,
      jobId: queued.job.id,
      status: 'queued'
    };
  }

  registerJobs() {
    this.jobs.register({
      jobType: 'application.export',
      handler: async ({ job, updateProgress }) => {
        const { exportId } = JSON.parse(job.payload_json) as { exportId: string };
        await this.generate({
          exportId,
          updateProgress
        });
      }
    });
  }

  private async generate({
    exportId,
    updateProgress
  }: {
    exportId: string;
    updateProgress: ({
      current,
      total,
      cursor
    }: {
      current: number;
      total?: number | null;
      cursor?: unknown;
    }) => Promise<void>;
  }) {
    await mkdir(this.runtime.config.exports.directory, { recursive: true });
    const artifactPath = join(this.runtime.config.exports.directory, `${exportId}.tar.gz`);
    const pack = tar.pack();
    const gzip = createGzip({ level: 6 });
    const file = createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
    const archiveHash = createHash('sha256');
    const hashTap = new PassThrough();
    hashTap.on('data', (chunk: Buffer) => archiveHash.update(chunk));
    pack.pipe(gzip).pipe(hashTap).pipe(file);
    await this.db.run({
      sql: 'UPDATE application_exports SET status = \'running\', artifact_path = ? WHERE id = ?',
      parameters: [artifactPath, exportId]
    });
    const manifest = {
      schemaVersion: '1.0',
      applicationVersion: this.buildInfo.version,
      buildHash: this.buildInfo.buildHash,
      generatedAt: new Date().toISOString(),
      format: 'tar+gzip/jsonl',
      purpose: 'data-portability',
      backupNotice: 'This export is not a transaction-consistent database backup or an automated restore artifact.',
      exclusions: [
        'secrets',
        'provider credentials',
        'password hashes',
        'sessions',
        'cookies',
        'csrf tokens',
        'signed identity material'
      ],
      files: [] as Array<{
        path: string;
        rowCount: number;
        sha256: string;
      }>
    };
    try {
      for (let index = 0; index < publicTables.length; index += 1) {
        const table = publicTables[index]!;
        await updateProgress({
          current: index,
          total: publicTables.length + 1,
          cursor: { table }
        });
        const spoolPath = join(this.runtime.config.exports.directory, `.${exportId}.${table}.jsonl`);
        const spool = createWriteStream(spoolPath, { flags: 'wx', mode: 0o600 });
        const result = await streamTableJsonl({
          db: this.db,
          table,
          output: spool
        });
        const spoolDetails = await stat(spoolPath);
        const entryStream = pack.entry({
          name: `data/${table}.jsonl`,
          size: spoolDetails.size,
          mode: 0o600,
          mtime: new Date(0)
        });
        try {
          await pipeline(createReadStream(spoolPath), entryStream);
        } finally {
          await unlink(spoolPath).catch(() => undefined);
        }
        manifest.files.push({
          path: `data/${table}.jsonl`,
          ...result
        });
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      await new Promise<void>((resolve, reject) => {
        pack.entry({
          name: 'manifest.json',
          size: Buffer.byteLength(manifestText),
          mode: 0o600,
          mtime: new Date(0)
        }, manifestText, (error) => {
          if (error) return reject(error);
          return resolve();
        });
      });
      pack.finalize();
      await once(file, 'finish');
      const details = await stat(artifactPath);
      const checksumSha256 = archiveHash.digest('hex');
      const completedAtMs = Date.now();
      const expiresAtMs = completedAtMs + (this.runtime.config.exports.artifactTtlHours * 60 * 60_000);
      await this.db.run({
        sql: `
          UPDATE application_exports
          SET status = 'completed', manifest_json = ?, bytes_written = ?,
              checksum_sha256 = ?, completed_at_ms = ?, expires_at_ms = ?
          WHERE id = ?
        `,
        parameters: [
          JSON.stringify(manifest),
          details.size,
          checksumSha256,
          completedAtMs,
          expiresAtMs,
          exportId
        ]
      });
      await updateProgress({
        current: publicTables.length + 1,
        total: publicTables.length + 1,
        cursor: { complete: true }
      });
    } catch (error) {
      pack.destroy();
      file.destroy();
      await this.db.run({
        sql: 'UPDATE application_exports SET status = \'failed\', last_error_json = ? WHERE id = ?',
        parameters: [
          JSON.stringify({
            errorKey: 'EXPORT_GENERATION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }),
          exportId
        ]
      });
      throw new AppError({
        errorKey: 'EXPORT_GENERATION_FAILED',
        reason: 'Complete application export failed.',
        cause: error
      });
    }
  }

  async get({ id }: { id: string }) {
    const row = await this.db.one<ExportRow>({
      sql: 'SELECT * FROM application_exports WHERE id = ?',
      parameters: [id]
    });
    if (!row) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Application export was not found.',
        status: 404
      });
    }
    return {
      id: row.id,
      status: row.status,
      bytesWritten: row.bytes_written === null ? null : Number(row.bytes_written),
      checksumSha256: row.checksum_sha256,
      createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      completedAt: row.completed_at_ms ? new Date(Number(row.completed_at_ms)).toISOString() : null,
      expiresAt: row.expires_at_ms ? new Date(Number(row.expires_at_ms)).toISOString() : null,
      manifest: row.manifest_json ? JSON.parse(row.manifest_json) as unknown : null,
      error: row.last_error_json ? JSON.parse(row.last_error_json) as unknown : null,
      downloadable: row.status === 'completed' && Number(row.expires_at_ms ?? 0) > Date.now()
    };
  }

  async download({ id }: { id: string }) {
    const row = await this.db.one<ExportRow>({
      sql: 'SELECT * FROM application_exports WHERE id = ?',
      parameters: [id]
    });
    if (!row) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Application export was not found.',
        status: 404
      });
    }
    if (row.status !== 'completed' || !row.artifact_path) {
      throw new AppError({
        errorKey: 'EXPORT_NOT_READY',
        reason: 'Application export is not ready.',
        status: 409
      });
    }
    if (Number(row.expires_at_ms ?? 0) <= Date.now()) {
      throw new AppError({
        errorKey: 'EXPORT_EXPIRED',
        reason: 'Application export artifact has expired.',
        status: 410
      });
    }
    return {
      fileName: `cryptotracker-application-${id}.tar.gz`,
      stream: createReadStream(row.artifact_path),
      size: Number(row.bytes_written ?? 0),
      checksumSha256: row.checksum_sha256
    };
  }
}

export interface ExportableSeries {
  source?: string;
  chartMode?: string;
  quoteCurrency?: string;
  range?: unknown;
  requestedGranularity?: unknown;
  resolvedGranularity?: unknown;
  partial?: boolean;
  missingIntervals?: unknown[];
  series: Array<{
    id: string;
    label: string;
    points: Array<Record<string, unknown>>;
  }>;
}

const csvCell = ({ value }: { value: unknown }) => {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const serializeSeriesCsv = ({
  data,
  timezone
}: {
  data: ExportableSeries;
  timezone: string;
}) => {
  const header = [
    'timestamp_utc',
    'timestamp_display',
    'series_id',
    'series_label',
    'primary_value',
    'raw_value',
    'normalized_percent',
    'source',
    'status',
    'volume',
    'coverage',
    'provenance'
  ];
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  });
  const rows = data.series.flatMap((series) => series.points.map((point) => {
    const timestampMs = Number(point.timestampMs);
    return [
      new Date(timestampMs).toISOString(),
      formatter.format(new Date(timestampMs)),
      series.id,
      series.label,
      point.value ?? point.close ?? null,
      point.rawValue ?? point.value ?? point.close ?? null,
      point.normalizedPercent ?? null,
      data.source ?? '',
      point.status ?? '',
      point.volume ?? null,
      point.coveragePercent ?? null,
      point.provenance ?? point.contributingValues ?? null
    ].map((value) => csvCell({ value })).join(',');
  }));
  return `${header.join(',')}\n${rows.join('\n')}\n`;
};

export const serializeSeriesJson = ({
  data,
  buildInfo,
  locale,
  timezone,
  graphType,
  filters
}: {
  data: ExportableSeries;
  buildInfo: BuildInfo;
  locale: string;
  timezone: string;
  graphType: string;
  filters: Record<string, unknown>;
}) => ({
  schemaVersion: '1.0',
  applicationVersion: buildInfo.version,
  buildHash: buildInfo.buildHash,
  generatedAt: new Date().toISOString(),
  locale,
  timezone,
  graphType,
  source: data.source ?? null,
  range: data.range ?? null,
  requestedGranularity: data.requestedGranularity ?? null,
  resolvedGranularity: data.resolvedGranularity ?? null,
  filters,
  partial: data.partial ?? false,
  completeness: {
    missingIntervals: data.missingIntervals ?? []
  },
  series: data.series
});

export const applicationExportTables = [...publicTables];
