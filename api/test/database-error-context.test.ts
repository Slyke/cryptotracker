import { describe, expect, it } from 'vitest';
import { databaseInternals } from '../src/db/index.js';
import { AppError } from '../src/errors.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('database error context', () => {
  it('retains SQL structure while removing inline values and comments', () => {
    const preparedSql = databaseInternals.postgresSql({
      sql: `
        -- api_key=comment-secret
        SELECT "account's label", 'literal-secret', $$dollar-secret$$
        FROM accounts
        WHERE password = 'hunter2'
          AND api_key = ?
          AND identifier = ?
        /* private_key=block-secret */
      `
    });
    const sanitized = databaseInternals.sanitizeSqlForLogging({ sql: preparedSql });

    expect(sanitized).toContain('SELECT "account\'s label"');
    expect(sanitized).toContain('FROM accounts');
    expect(sanitized).toContain('password=[REDACTED]');
    expect(sanitized).toContain('api_key=[REDACTED]');
    expect(sanitized).toContain('identifier = $2');
    expect(sanitized).toContain('/* [REDACTED] */');
    expect(sanitized).not.toContain('comment-secret');
    expect(sanitized).not.toContain('literal-secret');
    expect(sanitized).not.toContain('dollar-secret');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain('block-secret');
  });

  it('sanitizes database-driver messages that may echo values', () => {
    const sanitized = databaseInternals.sanitizeDatabaseErrorMessage({
      message: 'duplicate key value violates "users_api_key_key"; Key (api_key)=(raw-secret) password=\'hunter2\''
    });

    expect(sanitized).toContain('duplicate key value violates "[REDACTED]"');
    expect(sanitized).toContain('(api_key)=([REDACTED])');
    expect(sanitized).toContain('password=[REDACTED]');
    expect(sanitized).not.toContain('users_api_key_key');
    expect(sanitized).not.toContain('raw-secret');
    expect(sanitized).not.toContain('hunter2');
  });

  it('adds sanitized SQL context to executor failures without logging parameters', async () => {
    const { db } = await openMigratedTestDatabase();

    try {
      await expect(db.transaction({
        task: (executor) => executor.one({
          sql: `
            SELECT *
            FROM missing_sensitive_table
            WHERE password = 'inline-secret'
              AND api_key = ?
          `,
          parameters: ['bound-secret']
        })
      })).rejects.toSatisfy((caught: unknown) => {
        expect(caught).toBeInstanceOf(AppError);
        const error = caught as AppError;
        expect(error.errorKey).toBe('DATABASE_QUERY_FAILED');
        expect(error.message).toBe('SQLite query failed.');
        expect(error.context).toMatchObject({
          databaseKind: 'sqlite',
          operation: 'one',
          parameterCount: 1,
          databaseError: {
            name: 'SqliteError'
          }
        });
        const serializedContext = JSON.stringify(error.context);
        expect(serializedContext).toContain('missing_sensitive_table');
        expect(serializedContext).toContain('password=[REDACTED]');
        expect(serializedContext).toContain('api_key=[REDACTED]');
        expect(serializedContext).not.toContain('inline-secret');
        expect(serializedContext).not.toContain('bound-secret');
        return true;
      });
    } finally {
      await db.close();
    }
  });

  it('caps unusually large SQL statements in error context', () => {
    const sanitized = databaseInternals.sanitizeSqlForLogging({
      sql: `SELECT ${'column_name, '.repeat(1_000)} final_column FROM oversized_table`
    });

    expect(sanitized.length).toBeLessThan(4_200);
    expect(sanitized).toContain('… [truncated]');
  });
});
