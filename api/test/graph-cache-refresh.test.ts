import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphCacheService, type GraphCachePlan } from '../src/services/graph-cache.js';
import { createTestRuntime, createTestLogger } from './helpers.js';

const plan: GraphCachePlan = {
  id: 'portfolio:test', revision: 'v1', scope: 'portfolio', input: {}, sliding: false
};
const oldBody = JSON.stringify({ ok: true, data: 'old' });

const fixture = async () => {
  const runtime = await createTestRuntime({ config: { cache: { redis: { enabled: true } } } });
  let body: string | null = oldBody;
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  const load = vi.fn(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const transaction: Record<string, any> = {};
  for (const method of ['setEx', 'hSet', 'expire', 'hDel']) transaction[method] = vi.fn(() => transaction);
  transaction.exec = vi.fn().mockResolvedValue([]);
  transaction.del = vi.fn(() => { body = null; return transaction; });
  const client = {
    isReady: true,
    get: vi.fn(async (key: string) => key.endsWith(':activity')
      ? JSON.stringify({ atMs: Date.now(), inactivityMs: 60_000 }) : body),
    hGet: vi.fn(async () => JSON.stringify(plan)),
    hGetAll: vi.fn(async () => ({ [plan.id]: JSON.stringify(plan) })),
    set: vi.fn().mockResolvedValue('OK'),
    setEx: vi.fn(async (_key: string, _ttl: number, value: string) => { body = value; }),
    hSet: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(true),
    eval: vi.fn().mockResolvedValue(1),
    del: vi.fn(async () => { body = null; }),
    multi: vi.fn(() => transaction)
  };
  const service = new GraphCacheService(runtime, createTestLogger({ runtime }), load);
  Object.assign(service, { client });
  return { service, client, load, finish: (value: unknown) => finish(value),
    fail: () => fail(new Error('database unavailable')), clear: () => { body = null; } };
};

afterEach(() => vi.useRealTimers());

describe('graph cache refresh continuity', () => {
  it('serves the previous result during refresh and replaces it after success', async () => {
    const f = await fixture();
    const refresh = f.service.refreshAffected([{ domain: 'portfolio' }]);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    const requestLoad = vi.fn();
    expect(await f.service.getOrLoad({ plan, load: requestLoad })).toBe(oldBody);
    f.finish('new');
    await refresh;
    expect(JSON.parse(await f.service.getOrLoad({ plan, load: requestLoad })).data).toBe('new');
    expect(requestLoad).not.toHaveBeenCalled();
    expect(f.client.del).not.toHaveBeenCalled();
  });

  it('keeps the previous result when refreshing fails', async () => {
    const f = await fixture();
    const refresh = f.service.refreshAffected([{ domain: 'portfolio' }]);
    const failure = expect(refresh).rejects.toThrow('database unavailable');
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.fail();
    await failure;
    expect(await f.service.getOrLoad({ plan, load: vi.fn() })).toBe(oldBody);
  });

  it('refreshes after inactivity without deleting the available result', async () => {
    const f = await fixture();
    f.client.get.mockImplementation(async (key: string) => key.endsWith(':activity') ? null : oldBody);
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    expect(await f.service.getOrLoad({ plan, load: vi.fn() })).toBe(oldBody);
    expect(f.client.multi().del).not.toHaveBeenCalled();
    f.finish('new');
    await vi.waitFor(() => expect(f.client.setEx).toHaveBeenCalledOnce());
  });

  it('shares a slow local cold fill instead of starting a second database query', async () => {
    const f = await fixture();
    f.clear();
    vi.useFakeTimers();
    const first = f.service.getOrLoad({ plan, load: f.load });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.load).toHaveBeenCalledOnce();
    const secondLoad = vi.fn().mockResolvedValue('duplicate');
    const second = f.service.getOrLoad({ plan, load: secondLoad });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(secondLoad).not.toHaveBeenCalled();
    f.finish('new');
    expect(await second).toBe(await first);
    expect(f.load).toHaveBeenCalledOnce();
  });
});
