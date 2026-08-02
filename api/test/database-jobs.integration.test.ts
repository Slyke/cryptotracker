import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { AppError } from '../src/errors.js';
import { JobQueue } from '../src/jobs/queue.js';
import { databaseInternals, openDatabase } from '../src/db/index.js';
import { AddressService } from '../src/services/addresses.js';
import { createTestLogger, createTestRuntime, openMigratedTestDatabase } from './helpers.js';

const requiredTables = [
  'address_balance_events',
  'asset_catalog',
  'application_exports',
  'audit_log',
  'internal_transfer_matches',
  'jobs',
  'kraken_ledgers',
  'market_points',
  'portfolio_snapshots',
  'sessions',
  'tracked_addresses',
  'watched_assets'
];

describe('database migrations and persistent jobs', () => {
  it('removes address uniqueness without losing existing address children', async () => {
    const runtime = await createTestRuntime();
    const migrations = await databaseInternals.loadMigrations({ kind: 'sqlite' });
    const baseline = migrations.find((migration) => migration.version === '0001_beta_baseline')!;
    const connection = new BetterSqlite3(runtime.sqlitePath);
    connection.pragma('foreign_keys = ON');
    connection.exec(baseline.sql);
    connection.exec(`
      INSERT INTO schema_migrations(version, applied_at_ms)
      VALUES ('0001_beta_baseline', 1);
      INSERT INTO tracked_addresses(
        id, network, address, normalized_address, label,
        enabled, created_at_ms, updated_at_ms
      ) VALUES (
        'address-before-separation', 'ethereum',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000001',
        'Existing SHIB', 1, 1, 1
      );
      INSERT INTO address_asset_selections(
        id, address_id, canonical_asset_id, contract_or_mint,
        enabled, created_at_ms, updated_at_ms
      ) VALUES (
        'selection-before-separation', 'address-before-separation',
        'shiba-inu', '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
        1, 1, 1
      );
      INSERT INTO address_asset_selections(
        id, address_id, canonical_asset_id, contract_or_mint,
        enabled, created_at_ms, updated_at_ms
      ) VALUES
        (
          'duplicate-native-disabled', 'address-before-separation',
          'ethereum', NULL, 0, 1, 1
        ),
        (
          'duplicate-native-enabled', 'address-before-separation',
          'ethereum', NULL, 1, 2, 2
        );
      INSERT INTO address_sync_state(
        address_id, status, cursor_json, provider_boundary_json,
        warnings_json, updated_at_ms
      ) VALUES (
        'address-before-separation', 'complete', '{}', '{}', '[]', 1
      );
    `);
    connection.close();

    const db = await openDatabase({ runtime });
    try {
      await db.migrate();
      expect(await db.one<{ canonical_asset_id: string }>({
        sql: 'SELECT canonical_asset_id FROM address_asset_selections WHERE id = ?',
        parameters: ['selection-before-separation']
      })).toEqual({ canonical_asset_id: 'shiba-inu' });
      expect(await db.one<{ status: string }>({
        sql: 'SELECT status FROM address_sync_state WHERE address_id = ?',
        parameters: ['address-before-separation']
      })).toEqual({ status: 'complete' });
      expect(await db.query<{ id: string; enabled: number }>({
        sql: `
          SELECT id, enabled
          FROM address_asset_selections
          WHERE address_id = ? AND canonical_asset_id = 'ethereum'
        `,
        parameters: ['address-before-separation']
      })).toEqual([{
        id: 'duplicate-native-enabled',
        enabled: 1
      }]);

      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label,
            enabled, created_at_ms, updated_at_ms
          ) VALUES (?, 'ethereum', ?, ?, 'Separate ETH', 1, 2, 2)
        `,
        parameters: [
          'separate-native-address',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000001'
        ]
      });
      await db.run({
        sql: 'DELETE FROM tracked_addresses WHERE id = ?',
        parameters: ['address-before-separation']
      });
      expect(await db.one({
        sql: 'SELECT id FROM address_asset_selections WHERE id = ?',
        parameters: ['selection-before-separation']
      })).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('migrates SQLite, preserves exact text decimals, and retains old canonical rows', async () => {
    const { db } = await openMigratedTestDatabase();
    try {
      expect(await db.ping()).toBe(true);
      const tables = await db.listTables();
      expect(tables).toEqual(expect.arrayContaining(requiredTables));
      await db.run({
        sql: `
          INSERT INTO market_points(
            id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
            granularity_seconds, data_kind, close_value, retrieved_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        parameters: [
          'old-point',
          'fixture',
          'bitcoin',
          'CAD',
          1,
          300,
          'native',
          '123456789.123456789123456789',
          1
        ]
      });
      await db.run({
        sql: "DELETE FROM schema_migrations WHERE version = '0001_beta_baseline'"
      });
      for (const version of [
        '0001_initial',
        '0002_asset_catalog',
        '0003_job_diagnostics',
        '0004_kraken_earn_rates',
        '0005_portfolio_snapshots',
        '0006_kraken_account_observations',
        '0007_kraken_observation_indexes'
      ]) {
        await db.run({
          sql: 'INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)',
          parameters: [version, Date.now()]
        });
      }
      await db.migrate();
      expect(await db.one<{ version: string }>({
        sql: "SELECT version FROM schema_migrations WHERE version = '0001_beta_baseline'"
      })).toEqual({ version: '0001_beta_baseline' });
      expect(await db.one<{ close_value: string }>({
        sql: 'SELECT close_value FROM market_points WHERE id = ?',
        parameters: ['old-point']
      })).toEqual({
        close_value: '123456789.123456789123456789'
      });
      expect(await db.query<{ name: string }>({
        sql: `
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name IN (
            'market_points_asset_quote_time_idx',
            'market_points_disputed_asset_time_idx'
          )
          ORDER BY name
        `
      })).toEqual([
        { name: 'market_points_asset_quote_time_idx' },
        { name: 'market_points_disputed_asset_time_idx' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('serializes concurrent SQLite transactions over its single connection', async () => {
    const { db } = await openMigratedTestDatabase();
    try {
      const values = await Promise.all(
        Array.from({ length: 4 }, (_, index) => db.transaction({
          task: async (executor) => {
            await Promise.resolve();
            const row = await executor.one<{ value: number }>({
              sql: 'SELECT ? AS value',
              parameters: [index]
            });
            return row?.value;
          }
        }))
      );
      expect(values).toEqual([0, 1, 2, 3]);
    } finally {
      await db.close();
    }
  });

  it('coalesces idempotent work and resumes interrupted jobs', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const queue = new JobQueue(db, createTestLogger({ runtime }), 1);
    let executions = 0;
    queue.register({
      jobType: 'fixture',
      handler: async () => {
        executions += 1;
      }
    });
    try {
      const first = await queue.enqueue({
        jobType: 'fixture',
        resourceKey: 'resource',
        idempotencyKey: 'fixture:one',
        priority: 10
      });
      const second = await queue.enqueue({
        jobType: 'fixture',
        resourceKey: 'resource',
        idempotencyKey: 'fixture:two',
        priority: 10
      });
      expect(second.coalesced).toBe(true);
      expect(second.job.id).toBe(first.job.id);
      await db.run({
        sql: "UPDATE jobs SET status = 'running', locked_at_ms = ? WHERE id = ?",
        parameters: [Date.now(), first.job.id]
      });
      await queue.start();
      const deadline = Date.now() + 5_000;
      let status = '';
      while (Date.now() < deadline) {
        status = (await queue.getJob({ id: first.job.id }))?.status ?? '';
        if (status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe('completed');
      expect(executions).toBe(1);
    } finally {
      await queue.stop();
      await db.close();
    }
  });

  it('queues a continuation only after the current job completes', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const queue = new JobQueue(db, createTestLogger({ runtime }), 1);
    let executions = 0;
    queue.register({
      jobType: 'fixture-continuation',
      handler: async ({ job }) => {
        executions += 1;
        if (executions > 1) return;
        return {
          jobType: 'fixture-continuation',
          resourceKey: 'resource',
          idempotencyKey: `fixture:continuation:${job.id}`,
          priority: 10
        };
      }
    });
    try {
      await queue.enqueue({
        jobType: 'fixture-continuation',
        resourceKey: 'resource',
        idempotencyKey: 'fixture:continuation:first',
        priority: 10
      });
      await queue.start();
      const deadline = Date.now() + 5_000;
      let completed = 0;
      while (Date.now() < deadline) {
        completed = Number((await db.one<{ count: number | string }>({
          sql: `
            SELECT COUNT(*) AS count
            FROM jobs
            WHERE job_type = 'fixture-continuation' AND status = 'completed'
          `
        }))?.count ?? 0);
        if (completed === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(completed).toBe(2);
      expect(executions).toBe(2);
    } finally {
      await queue.stop();
      await db.close();
    }
  });

  it('publishes graph-visible data changes after the job commits', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const queue = new JobQueue(db, createTestLogger({ runtime }), 1);
    const observed: unknown[] = [];
    queue.onGraphDataChange(async (changes) => {
      const job = await db.one<{ status: string }>({
        sql: "SELECT status FROM jobs WHERE job_type = 'fixture-graph-change'"
      });
      observed.push({ changes, status: job?.status });
    });
    queue.register({
      jobType: 'fixture-graph-change',
      handler: async () => ({
        graphDataChanges: [{
          domain: 'market',
          assetIds: ['solana'],
          quoteCurrencies: ['CAD']
        }]
      })
    });
    try {
      const queued = await queue.enqueue({
        jobType: 'fixture-graph-change',
        resourceKey: 'solana:CAD',
        idempotencyKey: 'fixture:graph-change',
        priority: 10
      });
      await queue.start();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && observed.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await queue.getJob({ id: queued.job.id })).toMatchObject({ status: 'completed' });
      expect(observed).toEqual([{
        status: 'completed',
        changes: [{
          domain: 'market',
          assetIds: ['solana'],
          quoteCurrencies: ['CAD']
        }]
      }]);
    } finally {
      await queue.stop();
      await db.close();
    }
  });

  it('waits for a provider circuit cooldown without consuming the job attempt budget', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const queue = new JobQueue(db, createTestLogger({ runtime }), 1);
    const cooldownUntilMs = Date.now() + 60_000;
    queue.register({
      jobType: 'fixture-circuit',
      handler: async () => {
        throw new AppError({
          errorKey: 'PROVIDER_CIRCUIT_OPEN',
          reason: 'fixture is cooling down.',
          context: { cooldownUntilMs }
        });
      }
    });
    try {
      const queued = await queue.enqueue({
        jobType: 'fixture-circuit',
        resourceKey: 'provider:fixture',
        idempotencyKey: 'fixture:circuit',
        priority: 10,
        maxAttempts: 2
      });
      await queue.start();
      const deadline = Date.now() + 2_000;
      let job = await queue.getJob({ id: queued.job.id });
      while (Date.now() < deadline && job?.status !== 'retry') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await queue.getJob({ id: queued.job.id });
      }
      expect(job).toMatchObject({
        status: 'retry',
        attempts: 0
      });
      expect(Number(job?.next_retry_at_ms)).toBeGreaterThanOrEqual(cooldownUntilMs);
      expect(JSON.parse(job?.last_error_json ?? '{}')).toMatchObject({
        errorKey: 'PROVIDER_CIRCUIT_OPEN',
        retryAtMs: expect.any(Number)
      });
    } finally {
      await queue.stop();
      await db.close();
    }
  });

  it('does not retry a non-rate-limited upstream 4xx response', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const queue = new JobQueue(db, createTestLogger({ runtime }), 1);
    let executions = 0;
    queue.register({
      jobType: 'fixture-unsupported-range',
      handler: async () => {
        executions += 1;
        throw new AppError({
          errorKey: 'PROVIDER_REQUEST_FAILED',
          reason: 'fixture returned HTTP 401.',
          context: { provider: 'fixture', status: 401 }
        });
      }
    });
    try {
      const queued = await queue.enqueue({
        jobType: 'fixture-unsupported-range',
        resourceKey: 'provider:unsupported-range',
        idempotencyKey: 'fixture:unsupported-range',
        priority: 10,
        maxAttempts: 5
      });
      await queue.start();
      const deadline = Date.now() + 2_000;
      let job = await queue.getJob({ id: queued.job.id });
      while (Date.now() < deadline && job?.status !== 'failed') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await queue.getJob({ id: queued.job.id });
      }
      expect(job).toMatchObject({
        status: 'failed',
        attempts: 1
      });
      expect(executions).toBe(1);
    } finally {
      await queue.stop();
      await db.close();
    }
  });

  const postgresIt = process.env.TEST_POSTGRES === '1' ? it : it.skip;
  postgresIt('keeps PostgreSQL logically equivalent to SQLite', async () => {
    const sqlite = await openMigratedTestDatabase();
    const postgresRuntime = await createTestRuntime({
      databaseKind: 'postgres',
      config: {
        database: {
          postgres: {
            host: process.env.TEST_POSTGRES_HOST ?? 'postgres',
            port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
            database: process.env.TEST_POSTGRES_DATABASE ?? 'cryptotracker',
            user: process.env.TEST_POSTGRES_USER ?? 'cryptotracker',
            poolMax: 2,
            ssl: false,
            rejectUnauthorized: true
          }
        }
      },
      secrets: {
        postgresPassword: process.env.TEST_POSTGRES_PASSWORD ?? 'change-me'
      }
    });
    const postgres = await openDatabase({ runtime: postgresRuntime });
    try {
      await postgres.migrate();
      const sqliteTables = await sqlite.db.listTables();
      const postgresTables = await postgres.listTables();
      expect(postgresTables).toEqual(sqliteTables);
      for (const table of sqliteTables) {
        expect(await postgres.listColumns({ table })).toEqual(
          await sqlite.db.listColumns({ table })
        );
      }
      const now = Date.now();
      const addressId = `postgres-address-${now}`;
      await postgres.run({
        sql: `
          INSERT INTO asset_catalog(
            canonical_id, symbol, name, network, contract_or_mint,
            source, updated_at_ms
          ) VALUES (
            'shiba-inu', 'SHIB', 'Shiba Inu', 'ethereum',
            '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
            'postgres-parity', ?
          )
          ON CONFLICT(canonical_id) DO UPDATE SET
            symbol = excluded.symbol,
            name = excluded.name,
            updated_at_ms = excluded.updated_at_ms
        `,
        parameters: [now]
      });
      await postgres.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label,
            enabled, created_at_ms, updated_at_ms
          ) VALUES (?, 'ethereum', ?, ?, 'Postgres SHIB', 1, ?, ?)
        `,
        parameters: [addressId, addressId, addressId, now, now]
      });
      await postgres.run({
        sql: `
          INSERT INTO address_asset_selections(
            id, address_id, canonical_asset_id, contract_or_mint,
            enabled, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'shiba-inu', ?, 1, ?, ?)
        `,
        parameters: [
          `postgres-selection-${now}`,
          addressId,
          '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
          now,
          now
        ]
      });
      await postgres.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, provider_boundary_json,
            warnings_json, last_success_at_ms, updated_at_ms
          ) VALUES (?, 'partial', '{}', '{}', '[]', ?, ?)
        `,
        parameters: [addressId, now, now]
      });
      await postgres.run({
        sql: `
          INSERT INTO address_balance_points(
            id, address_id, canonical_asset_id, bucket_start_ms,
            granularity_seconds, quantity, price_coverage
          ) VALUES (?, ?, 'shiba-inu', ?, 0, '552733073', 'balance_observed')
        `,
        parameters: [`postgres-balance-${now}`, addressId, now]
      });
      for (const [currency, close] of [['CAD', '0.0000046'], ['USD', '0.0000034']] as const) {
        await postgres.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency,
              bucket_start_ms, granularity_seconds, data_kind,
              close_value, retrieved_at_ms
            ) VALUES (?, 'postgres-parity', 'shiba-inu', ?, ?, 300, 'native', ?, ?)
          `,
          parameters: [`postgres-price-${currency}-${now}`, currency, now, close, now]
        });
      }
      const addressService = new AddressService(
        postgres,
        postgresRuntime,
        new Map(),
        new JobQueue(postgres, createTestLogger({ runtime: postgresRuntime }), 1)
      );
      expect((await addressService.holdings({
        quoteCurrency: 'CAD',
        quoteCurrencies: ['CAD', 'USD']
      })).find((holding) => holding.addressId === addressId)).toMatchObject({
        assetSymbol: 'SHIB',
        quantity: '552733073',
        currentValues: {
          CAD: '2542.5721358',
          USD: '1879.2924482'
        }
      });
    } finally {
      await sqlite.db.close();
      await postgres.close();
    }
  });
});
