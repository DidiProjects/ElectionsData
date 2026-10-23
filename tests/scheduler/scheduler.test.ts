import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../../src/logger.js';
import { runWindow, type ScheduledTask } from '../../src/scheduler/scheduler.js';
import { FakeClock } from '../helpers.js';

const at = (iso: string) => new Date(iso);

function recordingTask(clock: FakeClock, name: string, intervalMs: number, durationMs = 0) {
  const runs: string[] = [];
  const task: ScheduledTask = {
    name,
    intervalMs,
    run: async () => {
      runs.push(clock.now().toISOString().slice(11, 19));
      clock.advance(durationMs);
    },
  };
  return { task, runs };
}

describe('runWindow', () => {
  it('does nothing when the window already closed', async () => {
    const clock = new FakeClock('2026-10-25T23:00:00Z');
    const { task, runs } = recordingTask(clock, 't', 1000);
    const onClose = vi.fn(async () => undefined);
    const outcome = await runWindow({
      clock,
      logger: silentLogger,
      window: { start: null, end: at('2026-10-25T22:00:00Z') },
      tasks: [task],
      onClose,
    });
    expect(outcome).toBe('already_closed');
    expect(runs).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waits for the start, runs at a fixed rate and stops at the end', async () => {
    const clock = new FakeClock('2026-10-25T19:59:00Z');
    const { task, runs } = recordingTask(clock, 'poll', 30_000, 10_000);
    const onClose = vi.fn(async () => undefined);
    const outcome = await runWindow({
      clock,
      logger: silentLogger,
      window: { start: at('2026-10-25T20:00:00Z'), end: at('2026-10-25T20:01:30Z') },
      tasks: [task],
      onClose,
    });
    expect(outcome).toBe('completed');
    // A 10s run followed by a 20s pause keeps the 30s cadence.
    expect(runs).toEqual(['20:00:00', '20:00:30', '20:01:00']);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(clock.now().toISOString()).toBe('2026-10-25T20:01:30.000Z');
  });

  it('starts immediately when the start is in the past or unset', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const { task, runs } = recordingTask(clock, 't', 60_000);
    await runWindow({
      clock,
      logger: silentLogger,
      window: { start: at('2026-10-25T19:00:00Z'), end: at('2026-10-25T20:00:01Z') },
      tasks: [task],
    });
    expect(runs).toEqual(['20:00:00']);
  });

  it('does not start another cycle when a timer fires slightly before the end', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const { task, runs } = recordingTask(clock, 't', 30_000);
    const earlyClock = Object.assign(Object.create(clock) as FakeClock, {
      sleep: async (ms: number, signal?: AbortSignal) => {
        await clock.sleep(ms, signal);
        clock.advance(-2);
      },
    });
    await runWindow({
      clock: earlyClock,
      logger: silentLogger,
      window: { start: null, end: at('2026-10-25T20:00:45Z') },
      tasks: [task],
    });
    expect(runs).toEqual(['20:00:00', '20:00:29']);
  });

  it('runs a task again right away when it overran its interval', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const { task, runs } = recordingTask(clock, 't', 10_000, 15_000);
    await runWindow({ clock, logger: silentLogger, window: { start: null, end: at('2026-10-25T20:00:40Z') }, tasks: [task] });
    expect(runs).toEqual(['20:00:00', '20:00:15', '20:00:30']);
  });

  it('keeps running after a task throws', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const logger: Logger = { ...silentLogger, error: vi.fn() };
    let calls = 0;
    const task: ScheduledTask = {
      name: 'flaky',
      intervalMs: 1000,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
    };
    await runWindow({ clock, logger, window: { start: null, end: at('2026-10-25T20:00:02.500Z') }, tasks: [task] });
    expect(calls).toBe(3);
    expect(logger.error).toHaveBeenCalledWith('scheduled task failed', { task: 'flaky', error: 'boom' });
  });

  it('runs several tasks concurrently with their own intervals', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const fast = recordingTask(clock, 'fast', 1000);
    const slow = recordingTask(clock, 'slow', 2000);
    await runWindow({ clock, logger: silentLogger, window: { start: null, end: at('2026-10-25T20:00:03.500Z') }, tasks: [fast.task, slow.task] });
    expect(fast.runs.length).toBeGreaterThan(slow.runs.length);
    expect(slow.runs.length).toBeGreaterThanOrEqual(2);
  });

  it('stops when aborted and still runs onClose', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const controller = new AbortController();
    let calls = 0;
    const task: ScheduledTask = {
      name: 't',
      intervalMs: 1000,
      run: async () => {
        if (++calls === 2) controller.abort();
      },
    };
    const onClose = vi.fn(async () => undefined);
    const outcome = await runWindow({
      clock,
      logger: silentLogger,
      window: { start: null, end: null },
      tasks: [task],
      onClose,
      signal: controller.signal,
    });
    expect(outcome).toBe('aborted');
    expect(calls).toBe(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns aborted when stopped while waiting for the start', async () => {
    const clock = new FakeClock('2026-10-25T19:00:00Z');
    const { task, runs } = recordingTask(clock, 't', 1000);
    const outcome = await runWindow({
      clock,
      logger: silentLogger,
      window: { start: at('2026-10-25T20:00:00Z'), end: null },
      tasks: [task],
      signal: AbortSignal.abort(),
    });
    expect(outcome).toBe('aborted');
    expect(runs).toEqual([]);
  });
});
