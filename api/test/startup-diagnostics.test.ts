import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  buildStartupDiagnostics,
  startupDiagnosticsInternals,
  startupFailureEntry,
  startupSummary
} from '../src/startup-diagnostics.js';
import { createTestRuntime } from './helpers.js';

describe('startup diagnostics', () => {
  it('reports database, Redis, providers, and credential presence without credential values', async () => {
    const runtime = await createTestRuntime({
      databaseKind: 'postgres',
      config: {
        database: {
          postgres: {
            host: 'postgres.internal',
            port: 5_433,
            database: 'tracker',
            user: 'tracker',
            poolMax: 4,
            ssl: true,
            rejectUnauthorized: true
          }
        },
        cache: {
          redis: {
            enabled: true,
            url: 'redis://cache-user:url-secret@redis.internal:6380/2?token=query-secret',
            keyPrefix: 'test-prefix',
            resultTtlSeconds: 3_600,
            connectTimeoutMs: 750
          }
        }
      },
      secrets: {
        postgresPassword: 'postgres-secret',
        redisPassword: 'redis-secret',
        providers: {
          coinGeckoApiKey: 'coingecko-secret',
          blockCypherApiToken: null,
          etherscanApiKey: 'etherscan-secret',
          heliusApiKey: null,
          subscanApiKey: null
        },
        kraken: {
          apiKey: 'kraken-key',
          apiSecret: 'kraken-secret'
        }
      }
    });
    const diagnostics = buildStartupDiagnostics({
      runtime,
      buildInfo: { version: '0.1.7', buildHash: 'abc123' }
    });

    expect(diagnostics.database).toMatchObject({
      kind: 'postgres',
      host: 'postgres.internal',
      port: 5_433,
      database: 'tracker',
      credentialConfigured: true
    });
    expect(diagnostics.redis).toMatchObject({
      enabled: true,
      endpoint: 'redis://redis.internal:6380/2',
      credentialConfigured: true,
      fallback: 'postgres'
    });
    expect(diagnostics.providers.market.coinGecko.credentialConfigured).toBe(true);
    expect(diagnostics.providers.market.kraken.privateApiConfigured).toBe(true);
    expect(diagnostics.providers.chains.ethereum.credentialConfigured).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/postgres-secret|redis-secret|url-secret|query-secret|coingecko-secret|etherscan-secret|kraken-secret/);
    expect(startupSummary({ diagnostics })).toContain('db=postgres:postgres.internal:5433/tracker');
    expect(startupSummary({ diagnostics })).toContain('redis=enabled');
    expect(startupSummary({ diagnostics })).toContain('coingecko:set');
    expect(startupSummary({ diagnostics })).toContain('etherscan:set');
    expect(startupSummary({ diagnostics })).toContain('kraken-private:set');
  });

  it('reports SQLite mode and strips credentials and query strings from diagnostic endpoints', async () => {
    expect(startupDiagnosticsInternals.safeEndpoint({
      value: 'https://user:password@example.test:9443/path?api_key=secret#private'
    })).toBe('https://example.test:9443/path');

    const diagnostics = buildStartupDiagnostics({
      runtime: await createTestRuntime({ sqlitePath: '/data/tracker.sqlite' }),
      buildInfo: { version: '0.1.7', buildHash: 'development' }
    });
    expect(diagnostics.database).toMatchObject({
      kind: 'sqlite',
      path: '/data/tracker.sqlite'
    });
    expect(diagnostics.redis.enabled).toBe(false);
  });

  it('retains a sanitized database failure and startup phase', () => {
    const error = new AppError({
      errorKey: 'DATABASE_MIGRATION_FAILED',
      reason: 'Postgres migrations failed.',
      context: {
        databaseKind: 'postgres',
        operation: 'migration',
        databaseError: {
          name: 'Error',
          message: 'connect ECONNREFUSED postgres:5432',
          code: 'ECONNREFUSED'
        },
        password: 'must-not-leak'
      }
    });
    const entry = startupFailureEntry({
      error,
      phase: 'applying postgres database migrations'
    });

    expect(entry).toMatchObject({
      errorKey: 'DATABASE_MIGRATION_FAILED',
      message: 'Postgres migrations failed.',
      context: {
        startupPhase: 'applying postgres database migrations',
        failure: {
          databaseKind: 'postgres',
          operation: 'migration',
          databaseError: {
            code: 'ECONNREFUSED'
          },
          password: '[REDACTED]'
        }
      }
    });
    expect(JSON.stringify(entry)).not.toContain('must-not-leak');
  });
});
