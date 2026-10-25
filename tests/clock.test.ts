import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../src/clock.js';

describe('systemClock', () => {
  afterEach(() => vi.useRealTimers());

  it('now returns the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T20:00:00Z'));
    expect(systemClock.now().toISOString()).toBe('2026-10-25T20:00:00.000Z');
  });

  it('sleep resolves after the given delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = systemClock.sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('sleep resolves early when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = systemClock.sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleep resolves immediately for an already aborted signal or non-positive delay', async () => {
    await expect(systemClock.sleep(60_000, AbortSignal.abort())).resolves.toBeUndefined();
    await expect(systemClock.sleep(0)).resolves.toBeUndefined();
  });
});
