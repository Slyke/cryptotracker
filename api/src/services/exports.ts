import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  strFromU8,
  strToU8,
  unzipSync,
  Zip,
  ZipDeflate,
  type Unzipped
} from 'fflate';
import type { BuildInfo } from '../build-info.js';
import type { LoadedRuntime } from '../config/load.js';
import type {
  AppDatabase,
  DatabaseExecutor,
  DatabaseValue
} from '../db/index.js';
import { AppError } from '../errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { createId } from '../utils/ids.js';

const backupDomainIds = [
  'preferences',
  'markets',
  'addresses',
  'kraken',
  'portfolio',
  'calculations'
] as const;

export type BackupDomainId = typeof backupDomainIds[number];

interface BackupDomainDefinition {
  id: BackupDomainId;
  label: string;
  fileName: string;
  insertOrder: readonly string[];
  deleteOrder: readonly string[];
  userScoped?: boolean;
}

const backupDomains: readonly BackupDomainDefinition[] = [
  {
    id: 'preferences',
    label: 'Preferences',
    fileName: 'preferences.json',
    insertOrder: ['user_settings', 'selected_quote_currencies'],
    deleteOrder: ['selected_quote_currencies', 'user_settings'],
    userScoped: true
  },
  {
    id: 'markets',
    label: 'Markets and watchlist',
    fileName: 'markets.json',
    insertOrder: [
      'asset_catalog',
      'watched_assets',
      'asset_provider_mappings',
      'asset_lifecycle_events',
      'market_points',
      'market_sync_cursors'
    ],
    deleteOrder: [
      'market_points',
      'market_sync_cursors',
      'asset_lifecycle_events',
      'asset_provider_mappings',
      'watched_assets',
      'asset_catalog'
    ]
  },
  {
    id: 'addresses',
    label: 'Addresses and chain history',
    fileName: 'addresses.json',
    insertOrder: [
      'tracked_addresses',
      'address_asset_selections',
      'address_sync_state',
      'chain_transactions',
      'address_balance_events',
      'address_balance_points'
    ],
    deleteOrder: [
      'address_balance_points',
      'address_balance_events',
      'chain_transactions',
      'address_sync_state',
      'address_asset_selections',
      'tracked_addresses'
    ]
  },
  {
    id: 'kraken',
    label: 'Kraken account history',
    fileName: 'kraken.json',
    insertOrder: [
      'kraken_trades',
      'kraken_ledgers',
      'kraken_snapshots',
      'kraken_snapshot_balances',
      'kraken_margin_positions',
      'kraken_earn_allocations',
      'kraken_earn_strategy_rates',
      'kraken_account_observations',
      'kraken_sync_cursors'
    ],
    deleteOrder: [
      'kraken_snapshot_balances',
      'kraken_snapshots',
      'kraken_margin_positions',
      'kraken_earn_allocations',
      'kraken_earn_strategy_rates',
      'kraken_account_observations',
      'kraken_trades',
      'kraken_ledgers',
      'kraken_sync_cursors'
    ]
  },
  {
    id: 'portfolio',
    label: 'Portfolio snapshots',
    fileName: 'portfolio.json',
    insertOrder: ['portfolio_snapshots'],
    deleteOrder: ['portfolio_snapshots']
  },
  {
    id: 'calculations',
    label: 'Reconciliation and cost basis calculations',
    fileName: 'calculations.json',
    insertOrder: ['calculation_runs', 'cost_basis_lots', 'internal_transfer_matches'],
    deleteOrder: ['cost_basis_lots', 'calculation_runs', 'internal_transfer_matches']
  }
] as const;

const backupDomainById = new Map(backupDomains.map((domain) => [domain.id, domain]));
const backupDomainByFile = new Map(backupDomains.map((domain) => [domain.fileName, domain]));
const safeIdentifier = /^[a-z][a-z0-9_]*$/;

interface BackupDomainFile {
  schemaVersion: '1.0';
  domain: BackupDomainId;
  tables: Record<string, Array<Record<string, DatabaseValue>>>;
}

interface BackupManifest {
  schemaVersion: '1.0';
  applicationVersion: string;
  buildHash: string;
  generatedAt: string;
  format: 'zip/json';
  purpose: 'backup-and-restore';
  restoreMode: 'replace-selected-domains';
  exclusions: string[];
  files: Array<{
    domain: BackupDomainId;
    path: string;
    rowCount: number;
    tableCounts: Record<string, number>;
    sha256: string;
  }>;
}

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

interface ParsedBackup {
  manifest: BackupManifest;
  domains: Map<BackupDomainId, {
    definition: BackupDomainDefinition;
    data: BackupDomainFile;
    rowCount: number;
    tableCounts: Record<string, number>;
  }>;
}

const invalidBackup = ({
  reason,
  context
}: {
  reason: string;
  context?: unknown;
}) => new AppError({
  errorKey: 'BACKUP_INVALID',
  reason,
  status: 400,
  context
});

const asDatabaseValue = ({
  value,
  table,
  column
}: {
  value: unknown;
  table: string;
  column: string;
}): DatabaseValue => {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value;
  throw invalidBackup({
    reason: 'Backup row contains a value that cannot be stored.',
    context: { table, column }
  });
};

const parseJsonFile = <T>({
  archive,
  fileName
}: {
  archive: Unzipped;
  fileName: string;
}): T => {
  const bytes = archive[fileName];
  if (!bytes) throw invalidBackup({ reason: `Backup file ${fileName} is missing.` });
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch (error) {
    throw invalidBackup({
      reason: `Backup file ${fileName} does not contain valid JSON.`,
      context: { message: error instanceof Error ? error.message : String(error) }
    });
  }
};

const tableRows = async ({
  db,
  table,
  userId,
  onRows
}: {
  db: AppDatabase;
  table: string;
  userId: string;
  onRows: (rows: Array<Record<string, unknown>>) => Promise<void>;
}) => {
  let offset = 0;
  let rowCount = 0;
  while (true) {
    const rows = await db.query<Record<string, unknown>>({
      sql: `SELECT * FROM ${table}${['user_settings', 'selected_quote_currencies'].includes(table) ? ' WHERE user_id = ?' : ''} ORDER BY 1 LIMIT ? OFFSET ?`,
      parameters: [
        ...(['user_settings', 'selected_quote_currencies'].includes(table) ? [userId] : []),
        500,
        offset
      ]
    });
    if (rows.length === 0) break;
    await onRows(rows);
    rowCount += rows.length;
    offset += rows.length;
  }
  return rowCount;
};

export class ApplicationExportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly jobs: JobQueue,
    private readonly buildInfo: BuildInfo,
    private readonly userId: string
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
    const artifactPath = join(this.runtime.config.exports.directory, `${exportId}.zip`);
    const file = createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
    const archiveHash = createHash('sha256');
    let archiveError: unknown = null;
    let pendingDrain: Promise<void> | null = null;
    let resolveArchive!: () => void;
    let rejectArchive!: (error: unknown) => void;
    const archiveComplete = new Promise<void>((resolve, reject) => {
      resolveArchive = resolve;
      rejectArchive = reject;
    });
    file.once('error', (error) => rejectArchive(error));
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        archiveError = error;
        rejectArchive(error);
        file.destroy(error);
        return;
      }
      archiveHash.update(chunk);
      if (!file.write(Buffer.from(chunk))) {
        pendingDrain ??= once(file, 'drain').then(() => {
          pendingDrain = null;
        });
      }
      if (final) {
        file.end();
        resolveArchive();
      }
    });
    const waitForDrain = async () => {
      if (archiveError) throw archiveError;
      if (pendingDrain) await pendingDrain;
    };
    await this.db.run({
      sql: 'UPDATE application_exports SET status = \'running\', artifact_path = ? WHERE id = ?',
      parameters: [artifactPath, exportId]
    });
    const manifest: BackupManifest = {
      schemaVersion: '1.0',
      applicationVersion: this.buildInfo.version,
      buildHash: this.buildInfo.buildHash,
      generatedAt: new Date().toISOString(),
      format: 'zip/json',
      purpose: 'backup-and-restore',
      restoreMode: 'replace-selected-domains',
      exclusions: [
        'secrets',
        'provider credentials',
        'password hashes',
        'sessions',
        'cookies',
        'csrf tokens',
        'signed identity material',
        'jobs',
        'audit log',
        'generated export artifacts'
      ],
      files: []
    };
    try {
      for (let index = 0; index < backupDomains.length; index += 1) {
        const domain = backupDomains[index]!;
        await updateProgress({
          current: index,
          total: backupDomains.length + 1,
          cursor: { domain: domain.id }
        });
        const entry = new ZipDeflate(domain.fileName, { level: 6 });
        entry.mtime = new Date('1980-01-02T00:00:00.000Z');
        zip.add(entry);
        const checksum = createHash('sha256');
        const push = async ({
          text,
          final = false
        }: {
          text: string;
          final?: boolean;
        }) => {
          const bytes = strToU8(text);
          checksum.update(bytes);
          entry.push(bytes, final);
          await waitForDrain();
        };
        const tableCounts: Record<string, number> = {};
        let domainRowCount = 0;
        await push({
          text: `{"schemaVersion":"1.0","domain":${JSON.stringify(domain.id)},"tables":{`
        });
        for (let tableIndex = 0; tableIndex < domain.insertOrder.length; tableIndex += 1) {
          const table = domain.insertOrder[tableIndex]!;
          await push({ text: `${tableIndex === 0 ? '' : ','}${JSON.stringify(table)}:[` });
          let firstRow = true;
          const count = await tableRows({
            db: this.db,
            table,
            userId: this.userId,
            onRows: async (rows) => {
              for (const row of rows) {
                await push({
                  text: `${firstRow ? '' : ','}${JSON.stringify(row)}`
                });
                firstRow = false;
              }
            }
          });
          tableCounts[table] = count;
          domainRowCount += count;
          await push({ text: ']' });
        }
        await push({ text: '}}\n', final: true });
        manifest.files.push({
          domain: domain.id,
          path: domain.fileName,
          rowCount: domainRowCount,
          tableCounts,
          sha256: checksum.digest('hex')
        });
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      const manifestEntry = new ZipDeflate('manifest.json', { level: 6 });
      manifestEntry.mtime = new Date('1980-01-02T00:00:00.000Z');
      zip.add(manifestEntry);
      manifestEntry.push(strToU8(manifestText), true);
      zip.end();
      await archiveComplete;
      if (!file.writableFinished) await once(file, 'finish');
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
        current: backupDomains.length + 1,
        total: backupDomains.length + 1,
        cursor: { complete: true }
      });
    } catch (error) {
      zip.terminate();
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
        reason: 'Application backup generation failed.',
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
      fileName: `cryptotracker-backup-${id}.zip`,
      stream: createReadStream(row.artifact_path),
      size: Number(row.bytes_written ?? 0),
      checksumSha256: row.checksum_sha256
    };
  }

  private parseBackup({ archiveBytes }: { archiveBytes: Uint8Array }): ParsedBackup {
    let expandedBytes = 0;
    const allowedFiles = new Set([
      'manifest.json',
      ...backupDomains.map((domain) => domain.fileName)
    ]);
    let archive: Unzipped;
    try {
      archive = unzipSync(archiveBytes, {
        filter: (file) => {
          if (!allowedFiles.has(file.name)) {
            throw invalidBackup({
              reason: 'Backup contains an unexpected file.',
              context: { file: file.name }
            });
          }
          expandedBytes += file.originalSize;
          if (expandedBytes > this.runtime.config.exports.restoreMaxUncompressedBytes) {
            throw invalidBackup({
              reason: 'Expanded backup exceeds the configured restore limit.',
              context: {
                expandedBytes,
                limitBytes: this.runtime.config.exports.restoreMaxUncompressedBytes
              }
            });
          }
          return true;
        }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalidBackup({
        reason: 'Uploaded file is not a supported ZIP backup.',
        context: { message: error instanceof Error ? error.message : String(error) }
      });
    }
    const manifest = parseJsonFile<BackupManifest>({
      archive,
      fileName: 'manifest.json'
    });
    if (
      manifest.schemaVersion !== '1.0'
      || manifest.format !== 'zip/json'
      || manifest.purpose !== 'backup-and-restore'
      || manifest.restoreMode !== 'replace-selected-domains'
      || !Array.isArray(manifest.files)
    ) {
      throw invalidBackup({
        reason: 'Backup manifest version or format is not supported.'
      });
    }
    const parsedDomains = new Map<BackupDomainId, {
      definition: BackupDomainDefinition;
      data: BackupDomainFile;
      rowCount: number;
      tableCounts: Record<string, number>;
    }>();
    for (const [fileName, bytes] of Object.entries(archive)) {
      if (fileName === 'manifest.json') continue;
      const definition = backupDomainByFile.get(fileName);
      if (!definition) continue;
      const manifestFile = manifest.files.find((file) => (
        file.domain === definition.id && file.path === definition.fileName
      ));
      const actualChecksum = createHash('sha256').update(bytes).digest('hex');
      if (
        !manifestFile
        || typeof manifestFile.sha256 !== 'string'
        || manifestFile.sha256 !== actualChecksum
      ) {
        throw invalidBackup({
          reason: `Backup file ${fileName} failed its manifest checksum.`
        });
      }
      let data: BackupDomainFile;
      try {
        data = JSON.parse(strFromU8(bytes)) as BackupDomainFile;
      } catch (error) {
        throw invalidBackup({
          reason: `Backup file ${fileName} does not contain valid JSON.`,
          context: { message: error instanceof Error ? error.message : String(error) }
        });
      }
      if (
        data.schemaVersion !== '1.0'
        || data.domain !== definition.id
        || !data.tables
        || typeof data.tables !== 'object'
        || Array.isArray(data.tables)
      ) {
        throw invalidBackup({
          reason: `Backup file ${fileName} has an invalid header.`
        });
      }
      const expectedTables = new Set(definition.insertOrder);
      const actualTables = Object.keys(data.tables);
      if (
        actualTables.length !== expectedTables.size
        || actualTables.some((table) => !expectedTables.has(table))
      ) {
        throw invalidBackup({
          reason: `Backup file ${fileName} has an unexpected table set.`,
          context: {
            expected: [...expectedTables],
            actual: actualTables
          }
        });
      }
      const tableCounts: Record<string, number> = {};
      let rowCount = 0;
      for (const table of definition.insertOrder) {
        const rows = data.tables[table];
        if (!Array.isArray(rows)) {
          throw invalidBackup({
            reason: `Backup table ${table} is not an array.`
          });
        }
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw invalidBackup({
              reason: `Backup table ${table} contains an invalid row.`
            });
          }
        }
        tableCounts[table] = rows.length;
        rowCount += rows.length;
      }
      parsedDomains.set(definition.id, {
        definition,
        data,
        rowCount,
        tableCounts
      });
    }
    if (parsedDomains.size === 0) {
      throw invalidBackup({
        reason: 'Backup contains no restorable domain files.'
      });
    }
    return {
      manifest,
      domains: parsedDomains
    };
  }

  inspect({ archiveBytes }: { archiveBytes: Uint8Array }) {
    const parsed = this.parseBackup({ archiveBytes });
    return {
      schemaVersion: parsed.manifest.schemaVersion,
      applicationVersion: parsed.manifest.applicationVersion,
      generatedAt: parsed.manifest.generatedAt,
      restoreMode: parsed.manifest.restoreMode,
      domains: [...parsed.domains.values()].map((domain) => ({
        id: domain.definition.id,
        label: domain.definition.label,
        fileName: domain.definition.fileName,
        rowCount: domain.rowCount,
        tableCounts: domain.tableCounts
      }))
    };
  }

  private async insertTable({
    executor,
    table,
    rows,
    rewriteUserId,
    allowedColumns
  }: {
    executor: DatabaseExecutor;
    table: string;
    rows: Array<Record<string, DatabaseValue>>;
    rewriteUserId: boolean;
    allowedColumns: Set<string>;
  }) {
    if (!safeIdentifier.test(table)) {
      throw invalidBackup({ reason: 'Backup contains an invalid table identifier.' });
    }
    for (const row of rows) {
      const normalized: Record<string, DatabaseValue> = {
        ...row,
        ...(rewriteUserId ? { user_id: this.userId } : {})
      };
      const columns = Object.keys(normalized);
      if (
        columns.length === 0
        || columns.some((column) => !safeIdentifier.test(column) || !allowedColumns.has(column))
      ) {
        throw invalidBackup({
          reason: `Backup row for ${table} contains an invalid column.`,
          context: { columns }
        });
      }
      const values = columns.map((column) => asDatabaseValue({
        value: normalized[column],
        table,
        column
      }));
      await executor.run({
        sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        parameters: values
      });
    }
  }

  async restore({
    archiveBytes,
    domains
  }: {
    archiveBytes: Uint8Array;
    domains: BackupDomainId[];
  }) {
    const selected = [...new Set(domains)];
    if (selected.length === 0) {
      throw invalidBackup({ reason: 'Select at least one backup file to restore.' });
    }
    const parsed = this.parseBackup({ archiveBytes });
    const selectedDomains = selected.map((id) => {
      const definition = backupDomainById.get(id);
      const data = parsed.domains.get(id);
      if (!definition || !data) {
        throw invalidBackup({
          reason: `Selected backup file ${id} is not present in the archive.`
        });
      }
      return data;
    });
    const allowedColumns = new Map<string, Set<string>>();
    for (const domain of selectedDomains) {
      for (const table of domain.definition.insertOrder) {
        if (!allowedColumns.has(table)) {
          allowedColumns.set(table, new Set(await this.db.listColumns({ table })));
        }
      }
    }
    try {
      await this.db.transaction({
        task: async (executor) => {
          for (const domain of selectedDomains) {
            for (const table of domain.definition.deleteOrder) {
              await executor.run({
                sql: `DELETE FROM "${table}"${domain.definition.userScoped ? ' WHERE user_id = ?' : ''}`,
                parameters: domain.definition.userScoped ? [this.userId] : []
              });
            }
          }
          for (const domain of selectedDomains) {
            for (const table of domain.definition.insertOrder) {
              await this.insertTable({
                executor,
                table,
                rows: domain.data.tables[table]!,
                rewriteUserId: Boolean(domain.definition.userScoped),
                allowedColumns: allowedColumns.get(table)!
              });
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof AppError && error.errorKey === 'BACKUP_INVALID') throw error;
      throw new AppError({
        errorKey: 'BACKUP_RESTORE_FAILED',
        reason: 'Selected backup files could not be restored.',
        status: 409,
        context: {
          domains: selected,
          message: error instanceof Error ? error.message : String(error)
        },
        cause: error
      });
    }
    return {
      restoredDomains: selectedDomains.map((domain) => ({
        id: domain.definition.id,
        label: domain.definition.label,
        rowCount: domain.rowCount
      })),
      restoredAt: new Date().toISOString()
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
  const raw = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  const withoutControls = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const numeric = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?)|(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?)|(?:\d+(?:[.,]\d+)?)|(?:[.,]\d+))(?:[eE][+-]?\d+)?%?$/.test(withoutControls.trim());
  const text = numeric
    ? withoutControls
    : withoutControls.replace(/^\s*[=+\-@]+/, '');
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

export const applicationExportTables = backupDomains.flatMap((domain) => [...domain.insertOrder]);
