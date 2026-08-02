import { describe, expect, it } from 'vitest';
import { ReadThroughCache } from '../src/utils/read-through-cache.js';

describe('read-through cache', () => {
  it('coalesces in-flight reads and retains successful values for the configured TTL', async () => {
    let nowMs = 1_000;
    let loads = 0;
    const cache = new ReadThroughCache({
      ttlMs: 5_000,
      maxEntries: 10,
      now: () => nowMs
    });
    const load = async () => {
      loads += 1;
      await Promise.resolve();
      return { load: loads };
    };

    const [left, right] = await Promise.all([
      cache.get({ key: 'graph', load }),
      cache.get({ key: 'graph', load })
    ]);
    expect(left).toEqual({ load: 1 });
    expect(right).toBe(left);
    expect(loads).toBe(1);

    nowMs += 4_999;
    await expect(cache.get({ key: 'graph', load })).resolves.toBe(left);
    expect(loads).toBe(1);

    nowMs += 1;
    await expect(cache.get({ key: 'graph', load })).resolves.toEqual({ load: 2 });
    expect(loads).toBe(2);
  });

  it('does not cache failed reads and bounds per-process memory use', async () => {
    const cache = new ReadThroughCache({ ttlMs: 5_000, maxEntries: 1 });
    let attempts = 0;
    const unstableLoad = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return 'recovered';
    };

    await expect(cache.get({ key: 'unstable', load: unstableLoad })).rejects.toThrow('temporary');
    await expect(cache.get({ key: 'unstable', load: unstableLoad })).resolves.toBe('recovered');
    expect(attempts).toBe(2);

    let firstLoads = 0;
    await cache.get({ key: 'first', load: async () => ++firstLoads });
    await cache.get({ key: 'second', load: async () => 'second' });
    await cache.get({ key: 'first', load: async () => ++firstLoads });
    expect(firstLoads).toBe(2);
  });

  it('evicts oldest values when the configured size budget is exceeded', async () => {
    const cache = new ReadThroughCache({
      ttlMs: 5_000,
      maxEntries: 10,
      maxSize: 6,
      sizeOf: (value) => String(value).length
    });
    let firstLoads = 0;
    await cache.get({ key: 'first', load: async () => `one-${++firstLoads}` });
    await cache.get({ key: 'second', load: async () => 'two-1' });
    await cache.get({ key: 'first', load: async () => `one-${++firstLoads}` });
    expect(firstLoads).toBe(2);
  });
});
