import { describe, expect, it, vi } from 'vitest';
import { createLoadQueue } from '../src/lib/dashboard-load-queue';

describe('dashboard load queue', () => {
  it('limits work and starts queued loads in order', async () => {
    const queue = createLoadQueue({ maximumConcurrent: 2 });
    const started: number[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;

    const loads = [1, 2, 3, 4].map((id) => queue(async () => {
      started.push(id);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return id;
    }));

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    releases.splice(0).forEach((release) => release());

    await expect(Promise.all(loads)).resolves.toEqual([1, 2, 3, 4]);
    expect(peakActive).toBe(2);
  });
});
