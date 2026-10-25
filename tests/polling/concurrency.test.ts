import { describe, expect, it } from 'vitest';
import { forEachWithConcurrency } from '../../src/polling/concurrency.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('forEachWithConcurrency', () => {
  it('processes every item without exceeding the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles an empty list', async () => {
    await expect(forEachWithConcurrency([], 4, async () => undefined)).resolves.toBeUndefined();
  });

  it('stops picking new items once aborted', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await forEachWithConcurrency(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) controller.abort();
      },
      controller.signal,
    );
    expect(seen).toEqual([1, 2]);
  });
});
