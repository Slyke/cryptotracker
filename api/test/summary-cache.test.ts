import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging/logger.js';
import { SummaryCacheService, type SummaryRequest } from '../src/services/summary-cache.js';
import { createTestRuntime } from './helpers.js';

const portfolio: SummaryRequest = { scope: 'portfolio', quoteCurrencies: ['CAD', 'USD'] };
const kraken: SummaryRequest = { scope: 'kraken', quoteCurrencies: ['CAD', 'USD'] };
const changes = [{ domain: 'market' as const, assetIds: ['bitcoin'], quoteCurrencies: ['CAD', 'USD'] }];
const oldData = { values: { CAD: '123.4567890123456789', USD: '91' } };
const newData = { values: { CAD: '150', USD: '111' } };

const fixture = async (enabled = true, slowOperationThresholdMs = 30_000) => {
  const runtime = await createTestRuntime({ config: { cache: { redis: { enabled } } } });
  runtime.config.logging.slowOperationThresholdMs = slowOperationThresholdMs;
  const values = new Map<string, string>();
  const expires = new Map<string, number>();
  const requests = new Map<string, string>();
  const get = (key: string) => {
    if ((expires.get(key) ?? Infinity) <= Date.now()) values.delete(key);
    return values.get(key) ?? null;
  };
  const setEx = (key: string, ttl: number, value: string) => {
    values.set(key, value);
    expires.set(key, Date.now() + ttl * 1_000);
    return 'OK';
  };
  const client = {
    get: vi.fn(async (key: string) => get(key)),
    set: vi.fn(async (key: string, value: string, options: { NX: boolean; PX: number }) => {
      if (options.NX && get(key) !== null) return null;
      return setEx(key, options.PX / 1_000, value);
    }),
    setEx: vi.fn(async (key: string, ttl: number, value: string) => setEx(key, ttl, value)),
    hSet: vi.fn(async (_hash: string, key: string, value: string) => { requests.set(key, value); return 1; }),
    hGetAll: vi.fn(async () => Object.fromEntries(requests)),
    hDel: vi.fn(async (_hash: string, key: string) => Number(requests.delete(key))),
    expire: vi.fn(async () => true),
    eval: vi.fn(async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      if (get(keys[0]!) !== args[0]) return 0;
      if (keys.length === 2) return setEx(keys[1]!, Number(args[1]), args[2]!);
      return Number(values.delete(keys[0]!));
    })
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const load = vi.fn<(request: SummaryRequest) => Promise<unknown>>().mockResolvedValue(oldData);
  const redis = vi.fn(async () => enabled ? client : null);
  const createService = () => new SummaryCacheService(runtime, logger as unknown as Logger,
    redis as unknown as ConstructorParameters<typeof SummaryCacheService>[2], load);
  const service = createService();
  const resultKey = () => [...values.keys()].find((key) => key.includes(':result:') && !key.endsWith(':lock'))!;
  return { runtime, values, requests, client, logger, load, redis, service, createService, resultKey };
};

afterEach(() => vi.useRealTimers());

describe('Redis dashboard summary cache', () => {
  it.each([portfolio, kraken])('caches $scope numbers across service instances without chart activation', async (request) => {
    const f = await fixture();
    expect(await f.service.getOrLoad(request)).toMatchObject(oldData);
    const restarted = f.createService();
    expect(await restarted.getOrLoad(request)).toMatchObject(oldData);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.logger.info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      loggerKey: 'SUMMARY_CACHE_MISS', context: expect.objectContaining({ scope: request.scope, reason: 'result_not_found' })
    }));
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it('normalizes currencies but separates different sets, scopes and omitted defaults', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    await f.service.getOrLoad({ scope: 'portfolio', quoteCurrencies: [' usd ', 'cad', 'CAD'] });
    expect(f.load).toHaveBeenCalledOnce();
    await f.service.getOrLoad({ scope: 'portfolio', quoteCurrencies: ['EUR'] });
    await f.service.getOrLoad(kraken);
    await f.service.getOrLoad({ scope: 'portfolio' });
    await f.service.getOrLoad({ scope: 'portfolio', quoteCurrencies: [] });
    expect(f.load).toHaveBeenCalledTimes(5);
  });

  it('shares a cold calculation between concurrent requests beyond ten seconds', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise);
    const first = f.service.getOrLoad(portfolio);
    const second = f.service.getOrLoad(portfolio);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.logger.warn).not.toHaveBeenCalled();
    work.resolve(oldData);
    expect(await first).toEqual(oldData);
    expect(await second).toEqual(oldData);
  });

  it('shares a cold Redis fill across replicas instead of duplicating SQL after ten seconds', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise);
    const first = f.service.getOrLoad(portfolio);
    await vi.advanceTimersByTimeAsync(1);
    const second = f.createService().getOrLoad(portfolio);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.load).toHaveBeenCalledOnce();
    work.resolve(oldData);
    await vi.advanceTimersByTimeAsync(200);
    expect(await first).toEqual(oldData);
    expect(await second).toEqual(oldData);
  });

  it('serves successful values during refresh and replaces them atomically', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise);
    const refresh = f.service.refreshAffected(changes);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    work.resolve(newData);
    await refresh;
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.logger.info).toHaveBeenCalledOnce();
  });

  it('retains values after a failed refresh and retries on the next request', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    f.load.mockRejectedValueOnce(new Error('database offline'));
    await f.service.refreshAffected(changes);
    f.load.mockResolvedValue(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    await f.service.close();
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(3);
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('refreshes aged values in the background even without change events', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_001);
    f.load.mockResolvedValue(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    await f.service.close();
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.logger.info).toHaveBeenCalledOnce();
  });

  it('refreshes portfolio on address updates and both totals on Kraken/market updates', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    await f.service.getOrLoad(kraken);
    await f.service.refreshAffected([{ domain: 'addresses', assetIds: [] }]);
    expect(f.load.mock.calls.slice(2).map(([request]) => request.scope)).toEqual(['portfolio']);
    await f.service.refreshAffected([{ domain: 'kraken', assetIds: [] }]);
    expect(f.load.mock.calls.slice(3).map(([request]) => request.scope)).toEqual(['portfolio', 'kraken']);
    await f.service.refreshAffected(changes);
    expect(f.load).toHaveBeenCalledTimes(7);
  });

  it('rotates keys for changed settings/selection without resurrecting an in-flight old total', async () => {
    const f = await fixture();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise).mockResolvedValue(newData);
    const oldRequest = f.service.getOrLoad(portfolio);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    await f.service.invalidate(['portfolio', 'kraken']);
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    work.resolve(oldData);
    await oldRequest;
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('does not lose a second data change during a slow refresh', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise).mockResolvedValue(newData);
    const first = f.service.refreshAffected(changes);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    const second = f.service.refreshAffected(changes);
    await vi.waitFor(() => expect(f.client.setEx.mock.calls.filter(([key]) => key.includes(':generation:'))).toHaveLength(4));
    work.resolve(oldData);
    await Promise.all([first, second]);
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(3);
  });

  it('prevents a calculation whose lock expired from overwriting a newer replica result', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise).mockResolvedValue(newData);
    const first = f.service.getOrLoad(portfolio);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await f.createService().getOrLoad(portfolio)).toEqual(newData);
    work.resolve(oldData);
    await first;
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
  });

  it('falls back when Redis is unavailable, but stays silent when disabled', async () => {
    const f = await fixture();
    f.redis.mockResolvedValue(null);
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      loggerKey: 'SUMMARY_CACHE_MISS', context: expect.objectContaining({ reason: 'redis_unavailable' })
    }));
    const disabled = await fixture(false);
    expect(await disabled.service.getOrLoad(portfolio)).toEqual(oldData);
    expect(disabled.logger.info).not.toHaveBeenCalled();
  });

  it('falls back after a Redis read error and does not retry a failed SQL calculation', async () => {
    const f = await fixture();
    f.client.get.mockRejectedValueOnce(new Error('Redis offline'));
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    f.load.mockRejectedValueOnce(new Error('query failed'));
    await expect(f.service.getOrLoad(portfolio)).rejects.toThrow('query failed');
    expect(f.load).toHaveBeenCalledTimes(2);
    f.load.mockResolvedValue(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(3);
  });

  it('returns successful calculations without repeating SQL when a Redis write fails', async () => {
    const f = await fixture();
    f.client.eval.mockRejectedValueOnce(new Error('write failed'));
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });

  it('repairs a corrupt cache entry instead of permanently bypassing Redis', async () => {
    const f = await fixture();
    await f.service.getOrLoad(portfolio);
    f.values.set(f.resultKey(), '{broken json');
    f.load.mockResolvedValue(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it.each([1_000, 30_000, 60_000])('warns only after the configured %i ms and cancels the timer', async (thresholdMs) => {
    const f = await fixture(true, thresholdMs);
    vi.useFakeTimers();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise);
    const request = f.service.getOrLoad(portfolio);
    await vi.advanceTimersByTimeAsync(thresholdMs);
    expect(f.logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      loggerKey: 'SUMMARY_CACHE_SLOW',
      message: `Dashboard summary request exceeded ${thresholdMs} ms.`,
      context: expect.objectContaining({ phase: 'request', thresholdMs, elapsedMs: thresholdMs + 1 })
    }));
    work.resolve(oldData);
    await request;
    await vi.advanceTimersByTimeAsync(thresholdMs + 1_000);
    expect(f.logger.warn).toHaveBeenCalledOnce();
  });

  it('also warns for slow background calculations without logging warm hits as misses', async () => {
    const f = await fixture(true, 1_250);
    await f.service.getOrLoad(portfolio);
    vi.useFakeTimers();
    const work = Promise.withResolvers<unknown>();
    f.load.mockReturnValueOnce(work.promise);
    const refresh = f.service.refreshAffected(changes);
    await vi.advanceTimersByTimeAsync(1_251);
    expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      loggerKey: 'SUMMARY_CACHE_SLOW', context: expect.objectContaining({ phase: 'calculation', thresholdMs: 1_250 })
    }));
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    work.resolve(newData);
    await refresh;
    expect(f.logger.info).toHaveBeenCalledOnce();
  });

  it('updates the Kraken stale flag as time passes without recalculating amounts', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.load.mockResolvedValue({ ...oldData, stale: false,
      latestSuccessfulSync: new Date(Date.now() - f.runtime.config.sync.staleAfterMinutes * 60_000 + 1_000).toISOString() });
    expect(await f.service.getOrLoad(kraken)).toMatchObject({ stale: false });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await f.service.getOrLoad(kraken)).toMatchObject({ stale: true, ...oldData });
    expect(f.load).toHaveBeenCalledOnce();
  });

  it('stops refreshing inactive currency variants and resumes safely on the next request', async () => {
    const f = await fixture();
    expect(await f.service.isActive()).toBe(false);
    await f.service.getOrLoad(portfolio);
    expect(await f.service.isActive()).toBe(true);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(await f.service.isActive()).toBe(false);
    await f.service.refreshAffected(changes);
    expect(f.load).toHaveBeenCalledOnce();
    f.load.mockResolvedValue(newData);
    expect(await f.service.getOrLoad(portfolio)).toEqual(oldData);
    await f.service.close();
    expect(await f.service.getOrLoad(portfolio)).toEqual(newData);
  });
});
