import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';

export interface ScheduleWindow {
  start: Date | null;
  end: Date | null;
}

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
}

export interface RunWindowOptions {
  clock: Clock;
  logger: Logger;
  window: ScheduleWindow;
  tasks: ScheduledTask[];
  /** Runs once after the window closes (or the process is stopped), e.g. a final export. */
  onClose?: () => Promise<void>;
  signal?: AbortSignal;
}

export type WindowOutcome = 'already_closed' | 'completed' | 'aborted';

const msUntil = (clock: Clock, date: Date | null): number =>
  date === null ? Number.POSITIVE_INFINITY : date.getTime() - clock.now().getTime();

/** Sleeps `ms` but never past the window end; returns false once the window is over. */
async function sleepWithinWindow(clock: Clock, ms: number, end: Date | null, signal: AbortSignal): Promise<boolean> {
  const remaining = msUntil(clock, end);
  if (remaining <= 0 || signal.aborted) return false;
  // Decided up front: timers can fire a few ms early, which would sneak in one extra cycle.
  const reachesEnd = ms >= remaining;
  await clock.sleep(Math.min(ms, remaining), signal);
  return !signal.aborted && !reachesEnd;
}

async function runTask(task: ScheduledTask, options: RunWindowOptions, signal: AbortSignal): Promise<void> {
  const { clock, logger, window } = options;
  for (;;) {
    const startedAt = clock.now().getTime();
    try {
      await task.run(signal);
    } catch (error) {
      logger.error('scheduled task failed', { task: task.name, error: (error as Error).message });
    }
    // Fixed-rate: a slow cycle shortens the pause instead of stacking requests on top of it.
    const elapsed = clock.now().getTime() - startedAt;
    if (!(await sleepWithinWindow(clock, Math.max(0, task.intervalMs - elapsed), window.end, signal))) return;
  }
}

export async function runWindow(options: RunWindowOptions): Promise<WindowOutcome> {
  const { clock, logger, window } = options;
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) controller.abort();

  try {
    if (msUntil(clock, window.end) <= 0) {
      logger.info('schedule window already closed, nothing to do', { end: window.end?.toISOString() });
      return 'already_closed';
    }

    const untilStart = msUntil(clock, window.start);
    if (window.start && untilStart > 0) {
      logger.info('waiting for schedule window to open', { start: window.start.toISOString() });
      await clock.sleep(untilStart, controller.signal);
      if (controller.signal.aborted) return 'aborted';
    }

    logger.info('schedule window open', { end: window.end?.toISOString() ?? null });
    await Promise.all(options.tasks.map((task) => runTask(task, options, controller.signal)));

    if (options.onClose) await options.onClose();
    const outcome = controller.signal.aborted ? 'aborted' : 'completed';
    logger.info('schedule window closed', { outcome });
    return outcome;
  } finally {
    options.signal?.removeEventListener('abort', forward);
  }
}
