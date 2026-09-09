import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphCacheService, type GraphCachePlan } from '../src/services/graph-cache.js';
import { createTestRuntime, createTestLogger } from './helpers.js';

const plan: GraphCachePlan = {
  id: 'portfolio:test', revision: 'v1', scope: 'portfolio', input: {}, sliding: false
};
const body = (data: unknown) => JSON.stringify({ ok: true, data });
const resultKey = (value: GraphCachePlan) => 'cryptotracker:dashboard-graphs:v1:result:'
  + createHash('sha256').update(value.id + '\0' + value.revision).digest('hex');
const changes = [{ domain: 'portfolio' as const, assetIds: [] }];
const deferred = () => Promise.withResolvers<unknown>();

const fixture = async (registeredPlans = [plan]) => {
  const runtime = await createTestRuntime({ config: { cache: { redis: { enabled: true } } } });
  const values = new Map<string, string>();
  const plans = new Map(registeredPlans.map((value) => [value.id, JSON.stringify(value)]));
  for (const value of registeredPlans) values.set(resultKey(value), body('old'));
  const activityKey = 'cryptotracker:dashboard-graphs:v1:activity';
  values.set(activityKey, JSON.stringify({ atMs: Date.now(), inactivityMs: 60_000 }));
  const load = vi.fn<(value: GraphCachePlan) => Promise<unknown>>().mockResolvedValue('fresh');
  const client = {
    isReady: true,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    hGet: vi.fn(async (_key: string, id: string) => plans.get(id) ?? null),
    hGetAll: vi.fn(async () => Object.fromEntries(plans)),
    set: vi.fn(async (key: string, value: string) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    setEx: vi.fn(async (key: string, _ttl: number, value: string) => { values.set(key, value); }),
    hSet: vi.fn(async (_key: string, id: string, value: string) => { plans.set(id, value); return 1; }),
    expire: vi.fn().mockResolvedValue(true),
    eval: vi.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      const key = options.keys[0]!;
      return values.get(key) === options.arguments[0] && values.delete(key) ? 1 : 0;
    }),
    del: vi.fn(async (key: string) => { values.delete(key); }),
    multi: vi.fn(() => {
      const operations: (() => void)[] = [];
      return {
        setEx: vi.fn((key: string, _ttl: number, value: string) => {
          operations.push(() => { values.set(key, value); });
        }),
        hSet: vi.fn((_key: string, id: string, value: string) => {
          operations.push(() => { plans.set(id, value); });
        }),
        del: vi.fn((key: string) => { operations.push(() => { values.delete(key); }); }),
        hDel: vi.fn((_key: string, ids: string[]) => {
          operations.push(() => { for (const id of ids) plans.delete(id); });
        }),
        expire: vi.fn(),
        exec: vi.fn(async () => { for (const operation of operations) operation(); })
      };
    })
  };
  const logger = createTestLogger({ runtime });
  vi.spyOn(logger, 'error');
  const service = new GraphCacheService(runtime, logger, load);
  Object.assign(service, { client });
  return { service, client, logger, load, values, activityKey };
};

afterEach(() => vi.useRealTimers());

describe('graph cache refresh continuity', () => {
  it('serves the previous result during refresh and replaces it after success', async () => {
    const f = await fixture();
    const work = deferred();
    f.load.mockReturnValueOnce(work.promise);
    const refresh = f.service.refreshAffected(changes);
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    const requestLoad = vi.fn();
    expect(await f.service.getOrLoad({ plan, load: requestLoad })).toBe(body('old'));
    work.resolve('new');
    await refresh;
    expect(await f.service.getOrLoad({ plan, load: requestLoad })).toBe(body('new'));
    expect(requestLoad).not.toHaveBeenCalled();
    expect(f.client.del).not.toHaveBeenCalled();
  });

  it('keeps the previous result after failure and retries on the next active page visit', async () => {
    const f = await fixture();
    f.load.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.service.refreshAffected(changes)).rejects.toThrow('database unavailable');
    expect(await f.service.getOrLoad({ plan, load: vi.fn() })).toBe(body('old'));
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.values.get(resultKey(plan))).toBe(body('fresh')));
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('refreshes after inactivity without deleting the available result', async () => {
    const f = await fixture();
    const work = deferred();
    f.load.mockReturnValueOnce(work.promise);
    f.values.delete(f.activityKey);
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    expect(await f.service.getOrLoad({ plan, load: vi.fn() })).toBe(body('old'));
    work.resolve('new');
    await vi.waitFor(() => expect(f.values.get(resultKey(plan))).toBe(body('new')));
  });

  it('refreshes later activation batches after inactivity', async () => {
    const allPlans = Array.from({ length: 101 }, (_, index) => ({ ...plan, id: 'graph:' + index }));
    const f = await fixture(allPlans);
    f.values.delete(f.activityKey);
    const registeredPlanIds = allPlans.map((value) => value.id);
    await f.service.activate({ plans: allPlans.slice(0, 100), registeredPlanIds, inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.values.get(resultKey(allPlans[99]!))).toBe(body('fresh')));
    expect(f.values.get(resultKey(allPlans[100]!))).toBe(body('old'));
    await f.service.activate({
      plans: allPlans.slice(100), registeredPlanIds, inactivityMinutes: 1, replacePlans: false
    });
    await vi.waitFor(() => expect(f.values.get(resultKey(allPlans[100]!))).toBe(body('fresh')));
    expect(f.load).toHaveBeenCalledTimes(101);
  });

  it('retries a failed reactivation even though the next visit is still active', async () => {
    const f = await fixture();
    f.values.delete(f.activityKey);
    f.load.mockRejectedValueOnce(new Error('database unavailable'));
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledOnce());
    expect(f.values.get(resultKey(plan))).toBe(body('old'));
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.values.get(resultKey(plan))).toBe(body('fresh')));
  });

  it('does not rebuild unchanged cached charts on active page refreshes', async () => {
    const f = await fixture();
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    await vi.waitFor(() => expect(f.client.get).toHaveBeenCalledWith(resultKey(plan)));
    await f.service.activate({ plans: [plan], inactivityMinutes: 1 });
    expect(await f.service.getOrLoad({ plan, load: vi.fn() })).toBe(body('old'));
    expect(f.load).not.toHaveBeenCalled();
  });

  it('shares a slow local cold fill instead of starting a second database query', async () => {
    const f = await fixture();
    f.values.delete(resultKey(plan));
    const work = deferred();
    const firstLoad = vi.fn(() => work.promise);
    vi.useFakeTimers();
    const first = f.service.getOrLoad({ plan, load: firstLoad });
    await vi.advanceTimersByTimeAsync(1);
    expect(firstLoad).toHaveBeenCalledOnce();
    const secondLoad = vi.fn().mockResolvedValue('duplicate');
    const second = f.service.getOrLoad({ plan, load: secondLoad });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(secondLoad).not.toHaveBeenCalled();
    work.resolve('new');
    expect(await second).toBe(await first);
    expect(firstLoad).toHaveBeenCalledOnce();
  });

  it('does not lose a data update arriving during a refresh lasting over 30 seconds', async () => {
    const f = await fixture();
    const firstWork = deferred();
    const secondWork = deferred();
    f.load.mockReturnValueOnce(firstWork.promise).mockReturnValueOnce(secondWork.promise);
    vi.useFakeTimers();
    const first = f.service.refreshAffected(changes);
    await vi.advanceTimersByTimeAsync(1);
    const second = f.service.refreshAffected(changes);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.load).toHaveBeenCalledOnce();
    firstWork.resolve('first');
    await first;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.load).toHaveBeenCalledTimes(2);
    // A completed older refresh must not clear the newer invalidation.
    expect(f.values.has(resultKey(plan) + ':refresh')).toBe(true);
    secondWork.resolve('second');
    await second;
    expect(f.values.get(resultKey(plan))).toBe(body('second'));
    expect(f.values.has(resultKey(plan) + ':refresh')).toBe(false);
  });

  it('releases a failed local fill so a later request can populate the cache', async () => {
    const f = await fixture();
    f.values.delete(resultKey(plan));
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('query failed'))
      .mockResolvedValueOnce('fallback')
      .mockResolvedValueOnce('recovered');
    expect(await f.service.getOrLoad({ plan, load })).toBe(body('fallback'));
    expect(await f.service.getOrLoad({ plan, load })).toBe(body('recovered'));
    expect(load).toHaveBeenCalledTimes(3);
    expect(f.values.get(resultKey(plan))).toBe(body('recovered'));
  });
});
