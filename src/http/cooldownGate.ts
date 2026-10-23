import type { Clock } from '../clock.js';

/**
 * Shared pause for every in-flight worker: when the TSE answers 429/503 to one
 * request, hammering it from the other workers would only prolong the throttle.
 */
export interface CooldownGate {
  pauseUntil(until: Date): void;
  wait(signal?: AbortSignal): Promise<void>;
}

export function createCooldownGate(clock: Clock): CooldownGate {
  let resumeAt = 0;
  return {
    pauseUntil(until) {
      resumeAt = Math.max(resumeAt, until.getTime());
    },
    async wait(signal) {
      while (!signal?.aborted) {
        const remaining = resumeAt - clock.now().getTime();
        if (remaining <= 0) return;
        await clock.sleep(remaining, signal);
      }
    },
  };
}
