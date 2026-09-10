import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging/logger.js';
import { withSlowOperationWarning } from '../src/logging/slow-operation.js';

const fixture = () => {
  const warn = vi.fn();
  const run = <T>(task: () => Promise<T>) => withSlowOperationWarning({
    logger: { warn } as unknown as Logger,
    thresholdMs: 1_000,
    caller: 'http::syncProgress',
    loggerKey: 'SYNC_PROGRESS_SLOW',
    label: 'Synchronization progress request',
    context: { method: 'GET', path: '/api/sync/progress' },
    task
  });
  return { warn, run };
};

afterEach(() => vi.useRealTimers());

describe('slow-operation warnings', () => {
  it('does not log fast work and cancels its warning timer', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(await f.run(async () => 'done')).toBe('done');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('warns once while a sync-progress operation is still pending', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const work = Promise.withResolvers<string>();
    const pending = f.run(() => work.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.warn).toHaveBeenCalledExactlyOnceWith({
      caller: 'http::syncProgress',
      loggerKey: 'SYNC_PROGRESS_SLOW',
      message: 'Synchronization progress request exceeded 1000 ms.',
      context: { method: 'GET', path: '/api/sync/progress', thresholdMs: 1_000, elapsedMs: 1_001 }
    });
    work.resolve('done');
    expect(await pending).toBe('done');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it('propagates failures and clears their warning timers', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await expect(f.run(async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('reports synchronous blocking work even when the timer did not get to fire', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.run(async () => {
      vi.setSystemTime(Date.now() + 1_500);
      return 'done';
    });
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      context: expect.objectContaining({ thresholdMs: 1_000, elapsedMs: 1_500 })
    }));
  });
});
