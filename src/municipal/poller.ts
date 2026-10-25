import type { Municipality, PollTarget } from './types.js';
import type { Logger } from '../logger.js';
import { targetKey, type ResultStore } from './resultStore.js';
import type { TrackingSnapshot, TseClient } from './tseClient.js';
import { forEachWithConcurrency } from '../polling/concurrency.js';

export interface PollStats {
  statesChecked: number;
  statesUnchanged: number;
  statesUnavailable: number;
  targetsDue: number;
  updated: number;
  notModified: number;
  notFound: number;
  invalid: number;
  failed: number;
  /** Targets with neither a stored valid result nor a confirmed 404. */
  missing: number;
  /** True when every target is accounted for, i.e. an export would not have gaps. */
  complete: boolean;
}

export interface Poller {
  pollOnce(signal?: AbortSignal): Promise<PollStats>;
}

export interface PollerOptions {
  client: TseClient;
  store: ResultStore;
  logger: Logger;
  states: string[];
  officeCodes: number[];
  concurrency: number;
}

const emptyStats = (): PollStats => ({
  statesChecked: 0,
  statesUnchanged: 0,
  statesUnavailable: 0,
  targetsDue: 0,
  updated: 0,
  notModified: 0,
  notFound: 0,
  invalid: 0,
  failed: 0,
  missing: 0,
  complete: false,
});

/**
 * Each cycle reads one tracking file per state (conditional GET, usually a 304) and only
 * fetches the municipality files whose totalization fingerprint moved since the last
 * successful fetch. A full sweep of ~5.7k files per office happens once, on the first cycle.
 */
export function createPoller(options: PollerOptions): Poller {
  const { client, store, logger } = options;
  let municipalities: Municipality[] | null = null;
  const trackingEtags = new Map<string, string | null>();
  const trackingSnapshots = new Map<string, TrackingSnapshot>();
  /** Fingerprint each target was last successfully reconciled against. */
  const reconciled = new Map<string, string>();
  const notPublished = new Set<string>();

  const loadMunicipalities = async (signal?: AbortSignal): Promise<Municipality[] | null> => {
    if (municipalities) return municipalities;
    try {
      municipalities = await client.getMunicipalities(options.states, signal);
      logger.info('municipality list loaded', { count: municipalities.length });
    } catch (error) {
      logger.error('municipality list unavailable, will retry next cycle', { error: (error as Error).message });
    }
    return municipalities;
  };

  const refreshTracking = async (state: string, stats: PollStats, signal?: AbortSignal): Promise<boolean> => {
    stats.statesChecked++;
    try {
      const response = await client.getTracking(state, trackingEtags.get(state) ?? null, signal);
      if (response.kind === 'updated') {
        trackingSnapshots.set(state, response.value);
        trackingEtags.set(state, response.etag);
        return true;
      }
      if (response.kind === 'not_modified' && trackingSnapshots.has(state)) {
        stats.statesUnchanged++;
        return true;
      }
      logger.warn('tracking file unusable, falling back to conditional fetch of every municipality', {
        state,
        kind: response.kind,
      });
    } catch (error) {
      logger.warn('tracking file request failed, falling back to conditional fetch of every municipality', {
        state,
        error: (error as Error).message,
      });
    }
    stats.statesUnavailable++;
    trackingEtags.delete(state);
    trackingSnapshots.delete(state);
    return false;
  };

  const fetchTarget = async (
    target: PollTarget,
    fingerprint: string | null,
    stats: PollStats,
    signal?: AbortSignal,
  ): Promise<void> => {
    const key = targetKey(target);
    const markReconciled = (): void => {
      if (fingerprint !== null) reconciled.set(key, fingerprint);
    };
    try {
      const stored = store.get(target);
      const response = await client.getMunicipalityResult(
        target.municipality,
        target.officeCode,
        stored?.etag ?? null,
        signal,
      );
      switch (response.kind) {
        case 'updated':
          store.update(target, response.value, response.etag);
          notPublished.delete(key);
          stats.updated++;
          markReconciled();
          return;
        case 'not_modified':
          stats.notModified++;
          markReconciled();
          return;
        case 'not_found':
          // e.g. a state with no runoff for governor: nothing to fetch until progress moves.
          stats.notFound++;
          if (!stored) notPublished.add(key);
          markReconciled();
          return;
        case 'invalid':
          stats.invalid++;
          logger.warn('discarded invalid result, keeping previous value', { target: key });
          return;
      }
    } catch (error) {
      if (signal?.aborted) return;
      stats.failed++;
      logger.warn('result request failed, keeping previous value', { target: key, error: (error as Error).message });
    }
  };

  return {
    async pollOnce(signal) {
      const stats = emptyStats();
      const list = await loadMunicipalities(signal);
      if (!list) return stats;

      const states = [...new Set(list.map((m) => m.state))];
      const trackingOk = new Map<string, boolean>();
      await forEachWithConcurrency(
        states,
        options.concurrency,
        async (state) => {
          trackingOk.set(state, await refreshTracking(state, stats, signal));
        },
        signal,
      );

      const due: Array<{ target: PollTarget; fingerprint: string | null }> = [];
      for (const municipality of list) {
        const snapshot = trackingOk.get(municipality.state) ? trackingSnapshots.get(municipality.state) : undefined;
        const fingerprint = snapshot?.get(municipality.code) ?? null;
        for (const officeCode of options.officeCodes) {
          const target: PollTarget = { municipality, officeCode };
          if (fingerprint !== null && reconciled.get(targetKey(target)) === fingerprint) continue;
          due.push({ target, fingerprint });
        }
      }
      stats.targetsDue = due.length;

      await forEachWithConcurrency(
        due,
        options.concurrency,
        ({ target, fingerprint }) => fetchTarget(target, fingerprint, stats, signal),
        signal,
      );

      for (const municipality of list) {
        for (const officeCode of options.officeCodes) {
          const target: PollTarget = { municipality, officeCode };
          if (!store.get(target) && !notPublished.has(targetKey(target))) stats.missing++;
        }
      }
      stats.complete = stats.missing === 0 && !signal?.aborted;
      return stats;
    },
  };
}
