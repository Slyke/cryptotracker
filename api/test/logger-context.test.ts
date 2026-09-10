import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import { Logger } from '../src/logging/logger.js';
import { JobQueue } from '../src/jobs/queue.js';
import type { AppDatabase } from '../src/db/index.js';
import { createTestRuntime } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('custom logger failure context', () => {
  it('retains job details alongside provider evidence and redacts both', async () => {
    const runtime = await createTestRuntime({ config: { logging: {
      sinks: { console: { enabled: true, format: 'json' } }
    } } });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Logger(runtime.config.logging).error({
      caller: 'jobs::execute', message: 'Job failed.',
      context: { jobId: 'job-test', jobType: 'address.sync', attempts: 1, maxAttempts: 5,
        terminal: true, nextRetryAtMs: null, apiKey: 'caller-secret' },
      error: new AppError({ errorKey: 'PROVIDER_REQUEST_FAILED', reason: 'Provider returned HTTP 403.',
        context: { provider: 'ethereum-json-rpc', status: 403, token: 'provider-secret' } })
    });
    expect(output).toHaveBeenCalledTimes(1);
    const rendered = String(output.mock.calls[0]![0]);
    expect(JSON.parse(rendered)).toMatchObject({
      caller: 'jobs::execute', errorKey: 'PROVIDER_REQUEST_FAILED',
      context: { jobId: 'job-test', jobType: 'address.sync', attempts: 1, maxAttempts: 5,
        terminal: true, nextRetryAtMs: null, provider: 'ethereum-json-rpc', status: 403,
        apiKey: '[REDACTED]', token: '[REDACTED]' }
    });
    expect(rendered).not.toContain('caller-secret');
    expect(rendered).not.toContain('provider-secret');
  });

  it('keeps custom logger gates effective for enriched errors', async () => {
    const runtime = await createTestRuntime({ config: { logging: {
      sinks: { console: { enabled: true } }, gates: { PROVIDER_REQUEST_FAILED: { enabled: false } }
    } } });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Logger(runtime.config.logging).error({ caller: 'fixture', message: 'Failure.',
      context: { jobId: 'job-test' },
      error: new AppError({ errorKey: 'PROVIDER_REQUEST_FAILED', reason: 'Failed.' }) });
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    { operation: undefined, failure: { status: 403 }, expected: { status: 403 } },
    { operation: { jobId: 'test' }, failure: null, expected: { jobId: 'test' } },
    { operation: 'startup', failure: ['detail'], expected: { operationContext: 'startup', errorContext: ['detail'] } }
  ])('preserves non-object and missing context: $expected', async ({ operation, failure, expected }) => {
    const runtime = await createTestRuntime({ config: { logging: {
      sinks: { console: { enabled: true, format: 'json' } }
    } } });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Logger(runtime.config.logging).error({
      caller: 'fixture', message: 'Failure.', context: operation,
      error: new AppError({ errorKey: 'PROVIDER_REQUEST_FAILED', reason: 'Failed.', context: failure })
    });
    expect(JSON.parse(String(output.mock.calls[0]![0])).context).toEqual(expected);
  });

  it('logs startup recovery only when interrupted jobs exist', async () => {
    const runtime = await createTestRuntime();
    const logger = new Logger(runtime.config.logging);
    const logged = vi.spyOn(logger, 'info');
    const run = vi.fn().mockResolvedValueOnce({ changes: 3 }).mockResolvedValueOnce({ changes: 0 });
    const queue = new JobQueue({ run } as unknown as AppDatabase, logger, 1);
    await queue.recoverInterrupted();
    await queue.recoverInterrupted();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({
      loggerKey: 'JOBS_RECOVERED', context: { recoveredJobs: 3 }
    }));
  });
});
