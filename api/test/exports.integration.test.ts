import { createGunzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import tar from 'tar-stream';
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
    const service = new ApplicationExportService(db, runtime, jobs, {
      version: '1.0.0',
      buildHash: 'fixture',
      builtAt: '2026-01-01T00:00:00.000Z'
    });
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
      expect(status.status).toBe('completed');
      expect(status.manifest).toMatchObject({
        schemaVersion: '1.0',
        purpose: 'data-portability'
      });
      expect(applicationExportTables).not.toEqual(expect.arrayContaining([
        'app_user',
        'sessions'
      ]));

      const download = await service.download({ id: created.id });
      const extract = tar.extract();
      const entryNames: string[] = [];
      const manifestChunks: Buffer[] = [];
      extract.on('entry', (header, stream, next) => {
        entryNames.push(header.name);
        stream.on('data', (chunk: Buffer) => {
          if (header.name === 'manifest.json') manifestChunks.push(chunk);
        });
        stream.on('end', next);
        stream.resume();
      });
      const complete = new Promise<void>((resolve, reject) => {
        extract.once('finish', resolve);
        extract.once('error', reject);
        download.stream.once('error', reject);
      });
      download.stream.pipe(createGunzip()).pipe(extract);
      await complete;
      expect(entryNames).toContain('manifest.json');
      expect(entryNames.some((name) => /app_user|sessions|secret|password/i.test(name))).toBe(false);
      const archiveManifest = JSON.parse(Buffer.concat(manifestChunks).toString('utf8')) as {
        exclusions: string[];
      };
      expect(archiveManifest.exclusions).toEqual(expect.arrayContaining([
        'secrets',
        'password hashes',
        'sessions'
      ]));
    } finally {
      await jobs.stop();
      await db.close();
    }
  });
});
