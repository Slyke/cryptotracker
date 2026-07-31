import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { LoadedRuntime } from '../config/load.js';
import { AppError, asAppError } from '../errors.js';

export type DatabaseValue = string | number | bigint | boolean | null;
export type DatabaseParameters = DatabaseValue[];

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
    return this.connection.prepare(sql).all(...parameters) as Row[];
  }

  async one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null> {
    return (this.connection.prepare(sql).get(...parameters) as Row | undefined) ?? null;
  }

  async run({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult> {
    const result = this.connection.prepare(sql).run(...parameters);
    return { changes: result.changes };
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
        this.connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await task(new SqliteExecutor(this.connection));
          this.connection.exec('COMMIT');
          return result;
        } catch (error) {
          if (this.connection.inTransaction) this.connection.exec('ROLLBACK');
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
    try {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at_ms INTEGER NOT NULL
        )
      `);
      const migrations = await loadMigrations({ kind: this.kind });
      const appliedRows = this.connection.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
      const applied = new Set(appliedRows.map((row) => row.version));

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        const foreignKeysEnabled = Number(this.connection.pragma('foreign_keys', { simple: true })) === 1;
        if (foreignKeysEnabled) this.connection.pragma('foreign_keys = OFF');
        try {
          this.connection.exec('BEGIN IMMEDIATE');
          try {
            this.connection.exec(migration.sql);
            const foreignKeyViolations = this.connection.pragma('foreign_key_check') as unknown[];
            if (foreignKeyViolations.length > 0) {
              throw new Error(`Migration ${migration.version} introduced a foreign-key violation.`);
            }
            this.connection.prepare('INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)').run(
              migration.version,
              Date.now()
            );
            this.connection.exec('COMMIT');
          } catch (error) {
            if (this.connection.inTransaction) this.connection.exec('ROLLBACK');
            throw error;
          }
        } finally {
          if (foreignKeysEnabled) this.connection.pragma('foreign_keys = ON');
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
    const result = this.connection.prepare('SELECT 1 AS ok').get() as { ok: number };
    return result.ok === 1;
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
    const result = await this.connection.query<Row>(postgresSql({ sql }), parameters);
    return result.rows;
  }

  async one<Row extends QueryResultRow = QueryResultRow>({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<Row | null> {
    const result = await this.connection.query<Row>(postgresSql({ sql }), parameters);
    return result.rows[0] ?? null;
  }

  async run({
    sql,
    parameters = []
  }: {
    sql: string;
    parameters?: DatabaseParameters;
  }): Promise<RunResult> {
    const result = await this.connection.query(postgresSql({ sql }), parameters);
    return { changes: result.rowCount ?? 0 };
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
    try {
      await client.query('BEGIN');
      const result = await task(new PostgresExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
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
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at_ms BIGINT NOT NULL
        )
      `);
      const migrations = await loadMigrations({ kind: this.kind });
      const client = await this.pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(3088192)');
        const result = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
        const applied = new Set(result.rows.map((row) => row.version));
        for (const migration of migrations) {
          if (applied.has(migration.version)) continue;
          await client.query('BEGIN');
          try {
            await client.query(migration.sql);
            await client.query(
              'INSERT INTO schema_migrations(version, applied_at_ms) VALUES ($1, $2)',
              [migration.version, Date.now()]
            );
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(3088192)').catch(() => undefined);
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
    const result = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }

  async estimateSizeBytes() {
    const result = await this.pool.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
    return Number(result.rows[0]?.size ?? 0);
  }

  async listTables() {
    const result = await this.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    return result.rows.map((row) => row.table_name);
  }

  async listColumns({ table }: { table: string }) {
    const result = await this.pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    return result.rows.map((row) => row.column_name);
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
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma(`busy_timeout = ${runtime.config.database.sqlite.busyTimeoutMs}`);
    connection.pragma(`synchronous = ${runtime.config.database.sqlite.synchronous}`);
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
  loadMigrations,
  postgresSql
};
