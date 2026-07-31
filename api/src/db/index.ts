import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { LoadedRuntime } from '../config/load.js';
import { AppError, asAppError } from '../errors.js';

export type DatabaseValue = string | number | bigint | boolean | null;
export type DatabaseParameters = DatabaseValue[];
type DatabaseKind = 'sqlite' | 'postgres';
type DatabaseOperation = 'query' | 'one' | 'run' | 'transaction' | 'migration' | 'open';

export interface RunResult {
  changes: number;
}

export interface DatabaseExecutor {
  query<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row[]>;
  one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null>;
  run({
    sql,
    parameters
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult>;
}

export interface AppDatabase extends DatabaseExecutor {
  readonly kind: 'sqlite' | 'postgres';
  transaction<T>({ task }: { task: (executor: DatabaseExecutor) => Promise<T> }): Promise<T>;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  estimateSizeBytes(): Promise<number>;
  listTables(): Promise<string[]>;
  listColumns({ table }: { table: string }): Promise<string[]>;
}

const sqliteSafeTableName = /^[a-z][a-z0-9_]*$/;
const maxLoggedSqlLength = 4_096;
const maxLoggedDatabaseMessageLength = 512;
const sensitiveSqlAssignmentPattern = /\b(password|secret|token|cookie|authorization|api[-_]?key|signature|private[-_]?key)\b\s*=\s*[^\s,;)]+/gi;

const truncateLoggedValue = ({
  value,
  maximumLength
}: {
  value: string;
  maximumLength: number;
}) => (
  value.length > maximumLength
    ? `${value.slice(0, maximumLength)} … [truncated]`
    : value
);

const sanitizeSqlForLogging = ({ sql }: { sql: string }) => {
  let output = '';
  let position = 0;

  while (position < sql.length) {
    const character = sql[position]!;
    const next = sql[position + 1];

    if (character === '-' && next === '-') {
      output += '/* [REDACTED] */ ';
      position += 2;
      while (position < sql.length && sql[position] !== '\n') position += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      output += '/* [REDACTED] */ ';
      position += 2;
      while (
        position < sql.length
        && !(sql[position] === '*' && sql[position + 1] === '/')
      ) {
        position += 1;
      }
      position = Math.min(position + 2, sql.length);
      continue;
    }

    if (character === '"') {
      const start = position;
      position += 1;
      while (position < sql.length) {
        if (sql[position] !== '"') {
          position += 1;
          continue;
        }
        if (sql[position + 1] === '"') {
          position += 2;
          continue;
        }
        position += 1;
        break;
      }
      output += sql.slice(start, position);
      continue;
    }

    if (character === '`') {
      const start = position;
      position += 1;
      while (position < sql.length) {
        if (sql[position] !== '`') {
          position += 1;
          continue;
        }
        if (sql[position + 1] === '`') {
          position += 2;
          continue;
        }
        position += 1;
        break;
      }
      output += sql.slice(start, position);
      continue;
    }

    if (character === "'") {
      output += "'[REDACTED]'";
      position += 1;
      while (position < sql.length) {
        if (sql[position] === '\\') {
          position += 2;
          continue;
        }
        if (sql[position] !== "'") {
          position += 1;
          continue;
        }
        if (sql[position + 1] === "'") {
          position += 2;
          continue;
        }
        position += 1;
        break;
      }
      continue;
    }

    if (character === '$') {
      const delimiter = sql.slice(position).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const bodyStart = position + delimiter.length;
        const bodyEnd = sql.indexOf(delimiter, bodyStart);
        output += `${delimiter}[REDACTED]${delimiter}`;
        position = bodyEnd === -1
          ? sql.length
          : bodyEnd + delimiter.length;
        continue;
      }
    }

    output += character;
    position += 1;
  }

  const normalized = output
    .replace(/\s+/g, ' ')
    .trim()
    .replace(sensitiveSqlAssignmentPattern, '$1=[REDACTED]');

  return truncateLoggedValue({
    value: normalized,
    maximumLength: maxLoggedSqlLength
  });
};

const sanitizeDatabaseErrorMessage = ({ message }: { message: string }) => {
  const redacted = message
    .replace(/'(?:''|[^'])*'/g, "'[REDACTED]'")
    .replace(/"(?:""|[^"])*"/g, '"[REDACTED]"')
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '($1)=([REDACTED])')
    .replace(sensitiveSqlAssignmentPattern, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateLoggedValue({
    value: redacted,
    maximumLength: maxLoggedDatabaseMessageLength
  });
};

const databaseDriverError = ({ error }: { error: unknown }) => {
  if (!(error instanceof Error)) {
    return {
      name: 'UnknownDatabaseError',
      message: 'The database driver threw a non-Error value.'
    };
  }

  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    message: sanitizeDatabaseErrorMessage({ message: error.message }),
    ...(typeof code === 'string' || typeof code === 'number'
      ? { code: String(code) }
      : {})
  };
};

const executeDatabaseOperation = async <Result>({
  kind,
  operation,
  sql,
  parameters = [],
  errorKey = 'DATABASE_QUERY_FAILED',
  reason,
  task
}: {
  kind: DatabaseKind;
  operation: DatabaseOperation;
  sql: string;
  parameters?: DatabaseParameters;
  errorKey?: string;
  reason: string;
  task: () => Result | Promise<Result>;
}): Promise<Result> => {
  try {
    return await task();
  } catch (error) {
    throw asAppError({
      error,
      errorKey,
      reason,
      context: {
        databaseKind: kind,
        operation,
        sql: sanitizeSqlForLogging({ sql }),
        parameterCount: parameters.length,
        databaseError: databaseDriverError({ error })
      }
    });
  }
};

const resolveMigrationsDirectory = ({
  kind
}: {
  kind: 'sqlite' | 'postgres';
}) => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CRYPTOTRACKER_MIGRATIONS_PATH
      ? join(process.env.CRYPTOTRACKER_MIGRATIONS_PATH, kind)
      : null,
    resolve(process.cwd(), 'api', 'migrations', kind),
    resolve(process.cwd(), 'migrations', kind),
    resolve(moduleDirectory, '..', '..', 'migrations', kind),
    resolve(moduleDirectory, '..', '..', '..', 'migrations', kind)
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates;
};

const loadMigrations = async ({
  kind
}: {
  kind: 'sqlite' | 'postgres';
}) => {
  for (const directory of resolveMigrationsDirectory({ kind })) {
    try {
      const files = (await readdir(directory))
        .filter((file) => /^\d+.*\.sql$/.test(file))
        .sort();
      if (files.length === 0) continue;
      return await Promise.all(
        files.map(async (file) => ({
          version: file.replace(/\.sql$/, ''),
          sql: await readFile(join(directory, file), 'utf8')
        }))
      );
    } catch {
      continue;
    }
  }

  throw new AppError({
    errorKey: 'DATABASE_MIGRATION_FAILED',
    reason: `No ${kind} migrations could be located.`,
    status: 500
  });
};

const postgresSql = ({ sql }: { sql: string }) => {
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let output = '';

  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position]!;
    const previous = sql[position - 1];

    if (character === "'" && !inDoubleQuote && previous !== '\\') {
      inSingleQuote = !inSingleQuote;
      output += character;
      continue;
    }

    if (character === '"' && !inSingleQuote && previous !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      output += character;
      continue;
    }

    if (character === '?' && !inSingleQuote && !inDoubleQuote) {
      index += 1;
      output += `$${index}`;
      continue;
    }

    output += character;
  }

  return output;
};

class SqliteExecutor implements DatabaseExecutor {
  constructor(protected readonly connection: BetterSqlite3.Database) {}

  async query<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row[]> {
    return executeDatabaseOperation({
      kind: 'sqlite',
      operation: 'query',
      sql,
      parameters,
      reason: 'SQLite query failed.',
      task: () => this.connection.prepare(sql).all(...parameters) as Row[]
    });
  }

  async one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null> {
    return executeDatabaseOperation({
      kind: 'sqlite',
      operation: 'one',
      sql,
      parameters,
      reason: 'SQLite query failed.',
      task: () => (
        (this.connection.prepare(sql).get(...parameters) as Row | undefined)
        ?? null
      )
    });
  }

  async run({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult> {
    return executeDatabaseOperation({
      kind: 'sqlite',
      operation: 'run',
      sql,
      parameters,
      reason: 'SQLite statement failed.',
      task: () => {
        const result = this.connection.prepare(sql).run(...parameters);
        return { changes: result.changes };
      }
    });
  }
}

class SqliteDatabase extends SqliteExecutor implements AppDatabase {
  readonly kind = 'sqlite' as const;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    connection: BetterSqlite3.Database,
    private readonly filePath: string
  ) {
    super(connection);
  }

  private async serialize<T>({
    task
  }: {
    task: () => Promise<T>;
  }): Promise<T> {
    const previousOperation = this.operationTail;
    let releaseOperation!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    await previousOperation;
    try {
      return await task();
    } finally {
      releaseOperation();
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row[]> {
    return this.serialize({
      task: () => super.query<Row>({ sql, parameters })
    });
  }

  async one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null> {
    return this.serialize({
      task: () => super.one<Row>({ sql, parameters })
    });
  }

  async run({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult> {
    return this.serialize({
      task: () => super.run({ sql, parameters })
    });
  }

  async transaction<T>({
    task
  }: {
    task: (executor: DatabaseExecutor) => Promise<T>;
  }): Promise<T> {
    return this.serialize({
      task: async () => {
        await executeDatabaseOperation({
          kind: this.kind,
          operation: 'transaction',
          sql: 'BEGIN IMMEDIATE',
          errorKey: 'DATABASE_TRANSACTION_FAILED',
          reason: 'SQLite transaction failed.',
          task: () => this.connection.exec('BEGIN IMMEDIATE')
        });
        try {
          const result = await task(new SqliteExecutor(this.connection));
          await executeDatabaseOperation({
            kind: this.kind,
            operation: 'transaction',
            sql: 'COMMIT',
            errorKey: 'DATABASE_TRANSACTION_FAILED',
            reason: 'SQLite transaction failed.',
            task: () => this.connection.exec('COMMIT')
          });
          return result;
        } catch (error) {
          if (this.connection.inTransaction) {
            await executeDatabaseOperation({
              kind: this.kind,
              operation: 'transaction',
              sql: 'ROLLBACK',
              errorKey: 'DATABASE_TRANSACTION_FAILED',
              reason: 'SQLite transaction rollback failed.',
              task: () => this.connection.exec('ROLLBACK')
            }).catch(() => undefined);
          }
          throw asAppError({
            error,
            errorKey: 'DATABASE_TRANSACTION_FAILED',
            reason: 'SQLite transaction failed.'
          });
        }
      }
    });
  }

  async migrate() {
    const migrationOperation = <Result>({
      sql,
      parameters = [],
      task
    }: {
      sql: string;
      parameters?: DatabaseParameters;
      task: () => Result | Promise<Result>;
    }) => executeDatabaseOperation({
      kind: this.kind,
      operation: 'migration',
      sql,
      parameters,
      errorKey: 'DATABASE_MIGRATION_FAILED',
      reason: 'SQLite migrations failed.',
      task
    });

    try {
      const schemaMigrationsSql = `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at_ms INTEGER NOT NULL
        )
      `;
      await migrationOperation({
        sql: schemaMigrationsSql,
        task: () => this.connection.exec(schemaMigrationsSql)
      });
      const migrations = await loadMigrations({ kind: this.kind });
      const appliedVersionsSql = 'SELECT version FROM schema_migrations';
      const appliedRows = await migrationOperation({
        sql: appliedVersionsSql,
        task: () => this.connection.prepare(appliedVersionsSql).all() as Array<{ version: string }>
      });
      const applied = new Set(appliedRows.map((row) => row.version));

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        const foreignKeysEnabled = Number(await migrationOperation({
          sql: 'PRAGMA foreign_keys',
          task: () => this.connection.pragma('foreign_keys', { simple: true })
        })) === 1;
        if (foreignKeysEnabled) {
          await migrationOperation({
            sql: 'PRAGMA foreign_keys = OFF',
            task: () => this.connection.pragma('foreign_keys = OFF')
          });
        }
        try {
          await migrationOperation({
            sql: 'BEGIN IMMEDIATE',
            task: () => this.connection.exec('BEGIN IMMEDIATE')
          });
          try {
            await migrationOperation({
              sql: migration.sql,
              task: () => this.connection.exec(migration.sql)
            });
            const foreignKeyViolations = await migrationOperation({
              sql: 'PRAGMA foreign_key_check',
              task: () => this.connection.pragma('foreign_key_check') as unknown[]
            });
            if (foreignKeyViolations.length > 0) {
              throw new Error(`Migration ${migration.version} introduced a foreign-key violation.`);
            }
            const recordMigrationSql = 'INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)';
            const recordMigrationParameters = [migration.version, Date.now()];
            await migrationOperation({
              sql: recordMigrationSql,
              parameters: recordMigrationParameters,
              task: () => this.connection.prepare(recordMigrationSql).run(...recordMigrationParameters)
            });
            await migrationOperation({
              sql: 'COMMIT',
              task: () => this.connection.exec('COMMIT')
            });
          } catch (error) {
            if (this.connection.inTransaction) {
              await migrationOperation({
                sql: 'ROLLBACK',
                task: () => this.connection.exec('ROLLBACK')
              }).catch(() => undefined);
            }
            throw error;
          }
        } finally {
          if (foreignKeysEnabled) {
            await migrationOperation({
              sql: 'PRAGMA foreign_keys = ON',
              task: () => this.connection.pragma('foreign_keys = ON')
            });
          }
        }
      }
    } catch (error) {
      throw asAppError({
        error,
        errorKey: 'DATABASE_MIGRATION_FAILED',
        reason: 'SQLite migrations failed.'
      });
    }
  }

  async ping() {
    const result = await this.one<{ ok: number }>({ sql: 'SELECT 1 AS ok' });
    return result?.ok === 1;
  }

  async close() {
    this.connection.close();
  }

  async estimateSizeBytes() {
    try {
      const files = [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`];
      const sizes = await Promise.all(files.map(async (filePath) => {
        try {
          return (await stat(filePath)).size;
        } catch {
          return 0;
        }
      }));
      return sizes.reduce((total, size) => total + size, 0);
    } catch {
      return 0;
    }
  }

  async listTables() {
    const rows = await this.query<{ name: string }>({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    });
    return rows.map((row) => row.name);
  }

  async listColumns({ table }: { table: string }) {
    if (!sqliteSafeTableName.test(table)) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: 'Invalid table identifier.',
        status: 400
      });
    }
    const rows = await this.query<{ name: string }>({ sql: `PRAGMA table_info(${table})` });
    return rows.map((row) => row.name);
  }
}

class PostgresExecutor implements DatabaseExecutor {
  constructor(protected readonly connection: Pool | PoolClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row[]> {
    const preparedSql = postgresSql({ sql });
    return executeDatabaseOperation({
      kind: 'postgres',
      operation: 'query',
      sql: preparedSql,
      parameters,
      reason: 'Postgres query failed.',
      task: async () => {
        const result = await this.connection.query<Row>(preparedSql, parameters);
        return result.rows;
      }
    });
  }

  async one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null> {
    const preparedSql = postgresSql({ sql });
    return executeDatabaseOperation({
      kind: 'postgres',
      operation: 'one',
      sql: preparedSql,
      parameters,
      reason: 'Postgres query failed.',
      task: async () => {
        const result = await this.connection.query<Row>(preparedSql, parameters);
        return result.rows[0] ?? null;
      }
    });
  }

  async run({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult> {
    const preparedSql = postgresSql({ sql });
    return executeDatabaseOperation({
      kind: 'postgres',
      operation: 'run',
      sql: preparedSql,
      parameters,
      reason: 'Postgres statement failed.',
      task: async () => {
        const result = await this.connection.query(preparedSql, parameters);
        return { changes: result.rowCount ?? 0 };
      }
    });
  }
}

class PostgresDatabase extends PostgresExecutor implements AppDatabase {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {
    super(pool);
  }

  async transaction<T>({
    task
  }: {
    task: (executor: DatabaseExecutor) => Promise<T>;
  }): Promise<T> {
    const client = await this.pool.connect();
    const transactionOperation = <Result>({
      sql,
      task
    }: {
      sql: string;
      task: () => Result | Promise<Result>;
    }) => executeDatabaseOperation({
      kind: this.kind,
      operation: 'transaction',
      sql,
      errorKey: 'DATABASE_TRANSACTION_FAILED',
      reason: 'Postgres transaction failed.',
      task
    });

    try {
      await transactionOperation({
        sql: 'BEGIN',
        task: () => client.query('BEGIN')
      });
      const result = await task(new PostgresExecutor(client));
      await transactionOperation({
        sql: 'COMMIT',
        task: () => client.query('COMMIT')
      });
      return result;
    } catch (error) {
      await transactionOperation({
        sql: 'ROLLBACK',
        task: () => client.query('ROLLBACK')
      }).catch(() => undefined);
      throw asAppError({
        error,
        errorKey: 'DATABASE_TRANSACTION_FAILED',
        reason: 'Postgres transaction failed.'
      });
    } finally {
      client.release();
    }
  }

  async migrate() {
    const migrationOperation = <Result>({
      sql,
      parameters = [],
      task
    }: {
      sql: string;
      parameters?: DatabaseParameters;
      task: () => Result | Promise<Result>;
    }) => executeDatabaseOperation({
      kind: this.kind,
      operation: 'migration',
      sql,
      parameters,
      errorKey: 'DATABASE_MIGRATION_FAILED',
      reason: 'Postgres migrations failed.',
      task
    });

    try {
      const schemaMigrationsSql = `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at_ms BIGINT NOT NULL
        )
      `;
      await migrationOperation({
        sql: schemaMigrationsSql,
        task: () => this.pool.query(schemaMigrationsSql)
      });
      const migrations = await loadMigrations({ kind: this.kind });
      const client = await this.pool.connect();
      try {
        const advisoryLockSql = 'SELECT pg_advisory_lock(3088192)';
        await migrationOperation({
          sql: advisoryLockSql,
          task: () => client.query(advisoryLockSql)
        });
        const appliedVersionsSql = 'SELECT version FROM schema_migrations';
        const result = await migrationOperation({
          sql: appliedVersionsSql,
          task: () => client.query<{ version: string }>(appliedVersionsSql)
        });
        const applied = new Set(result.rows.map((row) => row.version));
        for (const migration of migrations) {
          if (applied.has(migration.version)) continue;
          await migrationOperation({
            sql: 'BEGIN',
            task: () => client.query('BEGIN')
          });
          try {
            await migrationOperation({
              sql: migration.sql,
              task: () => client.query(migration.sql)
            });
            const recordMigrationSql = 'INSERT INTO schema_migrations(version, applied_at_ms) VALUES ($1, $2)';
            const recordMigrationParameters = [migration.version, Date.now()];
            await migrationOperation({
              sql: recordMigrationSql,
              parameters: recordMigrationParameters,
              task: () => client.query(recordMigrationSql, recordMigrationParameters)
            });
            await migrationOperation({
              sql: 'COMMIT',
              task: () => client.query('COMMIT')
            });
          } catch (error) {
            await migrationOperation({
              sql: 'ROLLBACK',
              task: () => client.query('ROLLBACK')
            }).catch(() => undefined);
            throw error;
          }
        }
      } finally {
        const advisoryUnlockSql = 'SELECT pg_advisory_unlock(3088192)';
        await migrationOperation({
          sql: advisoryUnlockSql,
          task: () => client.query(advisoryUnlockSql)
        }).catch(() => undefined);
        client.release();
      }
    } catch (error) {
      throw asAppError({
        error,
        errorKey: 'DATABASE_MIGRATION_FAILED',
        reason: 'Postgres migrations failed.'
      });
    }
  }

  async ping() {
    const result = await this.one<{ ok: number }>({ sql: 'SELECT 1 AS ok' });
    return result?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }

  async estimateSizeBytes() {
    const result = await this.one<{ size: string }>({
      sql: 'SELECT pg_database_size(current_database())::text AS size'
    });
    return Number(result?.size ?? 0);
  }

  async listTables() {
    const rows = await this.query<{ table_name: string }>({
      sql: `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `
    });
    return rows.map((row) => row.table_name);
  }

  async listColumns({ table }: { table: string }) {
    const rows = await this.query<{ column_name: string }>({
      sql: `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
        ORDER BY ordinal_position
      `,
      parameters: [table]
    });
    return rows.map((row) => row.column_name);
  }
}

export const openDatabase = async ({
  runtime
}: {
  runtime: LoadedRuntime;
}): Promise<AppDatabase> => {
  try {
    if (runtime.databaseKind === 'postgres') {
      const config = runtime.config.database.postgres!;
      const pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: runtime.secrets.postgresPassword!,
        max: config.poolMax,
        ssl: config.ssl
          ? { rejectUnauthorized: config.rejectUnauthorized }
          : undefined
      });
      return new PostgresDatabase(pool);
    }

    await mkdir(dirname(resolve(runtime.sqlitePath)), { recursive: true });
    const connection = new BetterSqlite3(runtime.sqlitePath);
    const openOperation = <Result>({
      sql,
      task
    }: {
      sql: string;
      task: () => Result | Promise<Result>;
    }) => executeDatabaseOperation({
      kind: 'sqlite',
      operation: 'open',
      sql,
      errorKey: 'DATABASE_OPEN_FAILED',
      reason: 'Unable to configure the sqlite database.',
      task
    });
    await openOperation({
      sql: 'PRAGMA journal_mode = WAL',
      task: () => connection.pragma('journal_mode = WAL')
    });
    await openOperation({
      sql: 'PRAGMA foreign_keys = ON',
      task: () => connection.pragma('foreign_keys = ON')
    });
    const busyTimeoutSql = `PRAGMA busy_timeout = ${runtime.config.database.sqlite.busyTimeoutMs}`;
    await openOperation({
      sql: busyTimeoutSql,
      task: () => connection.pragma(`busy_timeout = ${runtime.config.database.sqlite.busyTimeoutMs}`)
    });
    const synchronousSql = `PRAGMA synchronous = ${runtime.config.database.sqlite.synchronous}`;
    await openOperation({
      sql: synchronousSql,
      task: () => connection.pragma(`synchronous = ${runtime.config.database.sqlite.synchronous}`)
    });
    return new SqliteDatabase(connection, resolve(runtime.sqlitePath));
  } catch (error) {
    throw asAppError({
      error,
      errorKey: 'DATABASE_OPEN_FAILED',
      reason: `Unable to open the ${runtime.databaseKind} database.`
    });
  }
};

export const databaseInternals = {
  databaseDriverError,
  loadMigrations,
  postgresSql,
  sanitizeDatabaseErrorMessage,
  sanitizeSqlForLogging
};
