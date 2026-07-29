import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '../src/services/diagnostics.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('synchronization job diagnostics', () => {
  it('filters and paginates failed jobs independently from active progress', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const now = Date.now();
    try {
      for (let index = 0; index < 25; index += 1) {
        const matches = index < 15;
        await db.run({
          sql: `
            INSERT INTO jobs(
              id, job_type, resource_key, idempotency_key, priority, status,
              last_error_json, created_at_ms, updated_at_ms, completed_at_ms
            ) VALUES (?, ?, ?, ?, 40, 'failed', ?, ?, ?, ?)
          `,
          parameters: [
            `failed-${index}`,
            index % 2 === 0 ? 'market.fixture' : 'address.fixture',
            matches ? `needle:${index}` : `other:${index}`,
            `failed-key-${index}`,
            JSON.stringify({ message: matches ? 'needle failure' : 'other failure' }),
            now - index,
            now - index,
            now - index
          ]
        });
      }
      await db.run({
        sql: `
          INSERT INTO jobs(
            id, job_type, resource_key, idempotency_key, priority, status,
            created_at_ms, updated_at_ms
          ) VALUES ('active', 'fixture.sync', 'active', 'active-key', 10, 'running', ?, ?)
        `,
        parameters: [now, now]
      });

      const progress = await new DiagnosticsService(
        db,
        runtime,
        null as never,
        null as never,
        null as never
      ).syncProgress({
        failedQuery: 'needle',
        failedPage: 2,
        failedPageSize: 10
      });

      expect(progress.failedJobs).toMatchObject({
        total: 15,
        page: 2,
        pageSize: 10,
        pageCount: 2
      });
      expect(progress.failedJobs.items).toHaveLength(5);
      expect(progress.failedJobs.items.every((job) => job.target.includes('needle'))).toBe(true);
      expect(progress.failedJobs.types).toEqual(['address.fixture', 'market.fixture']);
      expect(progress.jobs.map((job) => job.id)).toContain('active');
      expect(progress.jobs.every((job) => job.status !== 'failed')).toBe(true);
    } finally {
      await db.close();
    }
  });
});
