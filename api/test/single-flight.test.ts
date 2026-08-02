import { describe, expect, it } from 'vitest';
import { SingleFlight } from '../src/utils/single-flight.js';

describe('single-flight request coalescing', () => {
  it('shares only an active request and never retains its result', async () => {
    const requests = new SingleFlight();
    let loads = 0;
    let release: (() => void) | null = null;
    const load = async () => {
      loads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return loads;
    };

    const first = requests.run({ key: 'graph-window', load });
    const second = requests.run({ key: 'graph-window', load });
    await Promise.resolve();
    expect(loads).toBe(1);
    release?.();
    expect(await Promise.all([first, second])).toEqual([1, 1]);

    const third = requests.run({ key: 'graph-window', load: async () => {
      loads += 1;
      return loads;
    } });
    expect(await third).toBe(2);
  });
});
