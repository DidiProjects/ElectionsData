import type { Clock } from '../clock.js';
import type { Section } from '../domain/types.js';
import type { Logger } from '../logger.js';
import { zoneKey, type SectionRepository, type ZoneRef } from '../results/sectionRepository.js';
import { sectionKey, type SectionStore } from '../results/sectionStore.js';
import type { UrnaClient } from '../urna/urnaClient.js';
import { forEachWithConcurrency } from './concurrency.js';

export interface SectionPollStats {
  statesChecked: number;
  statesUnchanged: number;
  statesUnavailable: number;
  /** Sections whose BU the TSE lists as published. */
  published: number;
  due: number;
  fetched: number;
  /** Listed as published but without a totalized BU yet; retried next job. */
  pending: number;
  invalid: number;
  failed: number;
  /** Due sections left for the next job because this one ran out of time. */
  deferred: number;
  stored: number;
  /** Sections loaded from the state volume on the first job after a start. */
  restored: number;
  persistedZones: number;
}

export interface SectionPoller {
  pollOnce(signal?: AbortSignal): Promise<SectionPollStats>;
}

export interface SectionPollerOptions {
  client: UrnaClient;
  store: SectionStore;
  repository: SectionRepository;
  logger: Logger;
  clock: Clock;
  states: string[];
  concurrency: number;
  /** Stop starting new sections after this long, so a huge batch cannot hold back the export. */
  jobBudgetMs: number;
}

const emptyStats = (): SectionPollStats => ({
  statesChecked: 0,
  statesUnchanged: 0,
  statesUnavailable: 0,
  published: 0,
  due: 0,
  fetched: 0,
  pending: 0,
  invalid: 0,
  failed: 0,
  deferred: 0,
  stored: 0,
  restored: 0,
  persistedZones: 0,
});

/**
 * Each job reads one section list per state (conditional GET, usually a 304) and fetches
 * aux + BU only for sections whose publication stamp is new. A BU is final, so a section
 * is downloaded once unless the TSE republishes it.
 */
export function createSectionPoller(options: SectionPollerOptions): SectionPoller {
  const { client, store, repository, logger, clock } = options;
  const lists = new Map<string, { etag: string | null; sections: Section[] }>();
  /** Publication stamp each section was last successfully fetched for. */
  const reconciled = new Map<string, string>();
  /** Zones with sections not yet written to the state volume (kept across jobs on failure). */
  const dirtyZones = new Map<string, ZoneRef>();
  let restored = false;

  const restore = async (stats: SectionPollStats): Promise<void> => {
    try {
      const results = await repository.loadAll();
      for (const result of results) {
        store.set(result);
        reconciled.set(sectionKey(result.section), result.section.publishedAt as string);
      }
      stats.restored = results.length;
      restored = true;
      if (results.length > 0) logger.info('restored sections from the state volume', { sections: results.length });
    } catch (error) {
      logger.error('state volume unreadable, downloading as if empty', { error: (error as Error).message });
    }
  };

  const persist = async (stats: SectionPollStats): Promise<void> => {
    for (const [key, zone] of dirtyZones) {
      try {
        await repository.saveZone(zone, store.inZone(zone.state, zone.municipalityCode, zone.zone));
        dirtyZones.delete(key);
        stats.persistedZones++;
      } catch (error) {
        logger.error('could not persist zone, will retry next job', { zone: key, error: (error as Error).message });
      }
    }
  };

  const refreshList = async (state: string, stats: SectionPollStats, signal?: AbortSignal): Promise<void> => {
    stats.statesChecked++;
    try {
      const response = await client.getSectionList(state, lists.get(state)?.etag ?? null, signal);
      if (response.kind === 'updated') {
        lists.set(state, { etag: response.etag, sections: response.sections });
        return;
      }
      if (response.kind === 'not_modified' && lists.has(state)) {
        stats.statesUnchanged++;
        return;
      }
      logger.warn('section list unusable, keeping the previous one', { state, kind: response.kind });
    } catch (error) {
      logger.warn('section list request failed, keeping the previous one', { state, error: (error as Error).message });
    }
    stats.statesUnavailable++;
    // Without the etag the next request downloads the list again instead of trusting a 304.
    const previous = lists.get(state);
    if (previous) lists.set(state, { etag: null, sections: previous.sections });
  };

  const fetchSection = async (section: Section, stats: SectionPollStats, deadline: number, signal?: AbortSignal) => {
    if (clock.now().getTime() >= deadline) {
      stats.deferred++;
      return;
    }
    const key = sectionKey(section);
    try {
      const aux = await client.getAux(section, signal);
      if (aux.kind === 'pending' || aux.kind === 'not_found') {
        stats.pending++;
        return;
      }
      if (aux.kind === 'invalid') {
        stats.invalid++;
        logger.warn('discarded invalid aux file', { section: key });
        return;
      }
      const report = await client.getReport(section, aux.hash, aux.fileName, signal);
      if (report.kind === 'not_found') {
        stats.pending++;
        return;
      }
      if (report.kind === 'invalid') {
        stats.invalid++;
        logger.warn('discarded invalid ballot box report', { section: key, reason: report.reason });
        return;
      }
      store.set({ section, hash: aux.hash, report: report.report });
      reconciled.set(key, section.publishedAt as string);
      dirtyZones.set(zoneKey(section), {
        state: section.state,
        municipalityCode: section.municipalityCode,
        zone: section.zone,
      });
      stats.fetched++;
    } catch (error) {
      if (signal?.aborted) return;
      stats.failed++;
      logger.warn('section request failed, will retry next job', { section: key, error: (error as Error).message });
    }
  };

  return {
    async pollOnce(signal) {
      const stats = emptyStats();
      if (!restored) await restore(stats);
      const deadline = clock.now().getTime() + options.jobBudgetMs;

      await forEachWithConcurrency(options.states, options.concurrency, (state) => refreshList(state, stats, signal), signal);

      const due: Section[] = [];
      for (const { sections } of lists.values()) {
        for (const section of sections) {
          if (section.publishedAt === null) continue;
          stats.published++;
          if (reconciled.get(sectionKey(section)) !== section.publishedAt) due.push(section);
        }
      }
      stats.due = due.length;

      await forEachWithConcurrency(due, options.concurrency, (s) => fetchSection(s, stats, deadline, signal), signal);
      // Also on abort: a redeploy's SIGTERM must not lose what this job downloaded.
      await persist(stats);
      stats.stored = store.size;
      return stats;
    },
  };
}
