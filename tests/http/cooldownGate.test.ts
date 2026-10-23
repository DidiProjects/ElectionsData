import { describe, expect, it } from 'vitest';
import { createCooldownGate } from '../../src/http/cooldownGate.js';
import { FakeClock } from '../helpers.js';

describe('createCooldownGate', () => {
  it('does not wait when no pause is set', async () => {
    const clock = new FakeClock();
    await createCooldownGate(clock).wait();
    expect(clock.sleeps).toEqual([]);
  });

  it('waits until the pause expires', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const gate = createCooldownGate(clock);
    gate.pauseUntil(new Date('2026-10-25T20:00:05Z'));
    await gate.wait();
    expect(clock.now().toISOString()).toBe('2026-10-25T20:00:05.000Z');
  });

  it('keeps the latest of overlapping pauses', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const gate = createCooldownGate(clock);
    gate.pauseUntil(new Date('2026-10-25T20:00:10Z'));
    gate.pauseUntil(new Date('2026-10-25T20:00:03Z'));
    await gate.wait();
    expect(clock.now().toISOString()).toBe('2026-10-25T20:00:10.000Z');
  });

  it('stops waiting when aborted', async () => {
    const clock = new FakeClock();
    const gate = createCooldownGate(clock);
    gate.pauseUntil(new Date(clock.now().getTime() + 60_000));
    await gate.wait(AbortSignal.abort());
    expect(clock.sleeps).toEqual([]);
  });
});
