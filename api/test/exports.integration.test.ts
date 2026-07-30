import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/queue.js';
import {
  ApplicationExportService,
  applicationExportTables,
  serializeSeriesCsv,
  serializeSeriesJson
} from '../src/services/exports.js';
import { createTestLogger, createTestRuntime, openMigratedTestDatabase } from './helpers.js';

describe('exports', () => {
  it('emits stable CSV and versioned JSON with selected graph state', () => {
    const data = {
      source: 'combined',
      partial: true,
      series: [{
        id: 'bitcoin',
        label: 'Bitcoin',
        points: [{
          timestampMs: 0,
          value: '10.25',
          rawValue: '10.25',
          normalizedPercent: '0',
          contributingValues: { a: '10', b: '10.5' }
        }]
      }]
    };
    const csv = serializeSeriesCsv({ data, timezone: 'America/Vancouver' });
    expect(csv).toContain('timestamp_utc,timestamp_display,series_id');
    expect(csv).toContain('bitcoin,Bitcoin,10.25');
    const sanitized = serializeSeriesCsv({
      data: {
        series: [{
          id: '=HYPERLINK("https://example.test")',
          label: '@malicious',
          points: [{
            timestampMs: 0,
            value: '-10.25'
          }]
        }, {
          id: '-1,234.56',
          label: '+1.234,56',
          points: [{
            timestampMs: 0,
            value: '1,234.56'
          }]
        }]
      },
      timezone: 'America/Vancouver'
    });
    expect(sanitized).not.toContain('=HYPERLINK');
    expect(sanitized).not.toContain('@malicious');
    expect(sanitized).toContain('-10.25');
    expect(sanitized).toContain('"-1,234.56"');
    expect(sanitized).toContain('"+1.234,56"');
    const json = serializeSeriesJson({
      data,
      buildInfo: {
        version: '1.2.3',
        buildHash: 'abc',
        builtAt: '2026-01-01T00:00:00.000Z'
      },
      locale: 'en-CA',
      timezone: 'America/Vancouver',
      graphType: 'line',
      filters: { assets: ['bitcoin'] }
    });
    expect(json).toMatchObject({
      schemaVersion: '1.0',
      applicationVersion: '1.2.3',
      buildHash: 'abc',
      graphType: 'line',
      partial: true
    });
  });

  it('streams non-secret application data and a versioned manifest', async () => {
    const runtime = await createTestRuntime({
      config: {
        exports: {
          directory: `${process.env.TMPDIR ?? '/tmp'}/cryptotracker-export-test`,
          artifactTtlHours: 1
        }
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const jobs = new JobQueue(db, createTestLogger({ runtime }), 1);
    await db.run({
      sql: `
        INSERT INTO app_user(id, username, created_at_ms, updated_at_ms)
        VALUES ('user:test', 'test', 0, 0)
      `
    });
    await db.run({
      sql: `
        INSERT INTO watched_assets(
          id, canonical_id, symbol, name, enabled, created_at_ms, updated_at_ms
        )
        VALUES ('asset:test', 'test-coin', 'TST', 'Test Coin', 1, 0, 0)
      `
    });
    const service = new ApplicationExportService(db, runtime, jobs, {
      version: '1.0.0',
      buildHash: 'fixture',
      builtAt: '2026-01-01T00:00:00.000Z'
    }, 'user:test');
    service.registerJobs();
    await jobs.start();
    try {
      const created = await service.create();
      const deadline = Date.now() + 10_000;
      let status = await service.get({ id: created.id });
      while (Date.now() < deadline && !['completed', 'failed'].includes(status.status)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await service.get({ id: created.id });
      }
      expect(status.status, JSON.stringify(status.error)).toBe('completed');
      expect(status.manifest).toMatchObject({
        schemaVersion: '1.0',
        purpose: 'backup-and-restore'
      });
      expect(applicationExportTables).not.toEqual(expect.arrayContaining([
        'app_user',
        'sessions'
      ]));
      expect(applicationExportTables).toEqual(expect.arrayContaining([
        'kraken_earn_strategy_rates',
        'kraken_account_observations'
      ]));

      const download = await service.download({ id: created.id });
      const archiveBytes = await readFile(download.stream.path as string);
      download.stream.destroy();
      const archive = unzipSync(archiveBytes);
      const entryNames = Object.keys(archive);
      expect(entryNames).toContain('manifest.json');
      expect(entryNames.some((name) => /app_user|sessions|secret|password/i.test(name))).toBe(false);
      const archiveManifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
        exclusions: string[];
      };
      expect(archiveManifest.exclusions).toEqual(expect.arrayContaining([
        'secrets',
        'password hashes',
        'sessions'
      ]));
      const inspection = service.inspect({
        archiveBytes
      });
      expect(inspection.domains.map((domain) => domain.id)).toEqual([
        'preferences',
        'markets',
        'addresses',
        'kraken',
        'portfolio',
        'calculations'
      ]);
      await db.run({ sql: 'DELETE FROM watched_assets' });
      const restored = await service.restore({
        archiveBytes,
        domains: ['markets']
      });
      expect(restored.restoredDomains).toEqual([
        expect.objectContaining({ id: 'markets' })
      ]);
      expect(await db.one<{ canonical_id: string }>({
        sql: 'SELECT canonical_id FROM watched_assets WHERE id = ?',
        parameters: ['asset:test']
      })).toEqual({ canonical_id: 'test-coin' });
    } finally {
      await jobs.stop();
      await db.close();
    }
  });
});
