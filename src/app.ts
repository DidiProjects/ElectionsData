import type { Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { createCandidateDirectory } from './export/candidateDirectory.js';
import { createExporter } from './export/exporter.js';
import { createVersionedCsvWriter } from './export/versionedCsvWriter.js';
import { createCooldownGate } from './http/cooldownGate.js';
import { createHttpClient, type FetchFn } from './http/httpClient.js';
import type { Logger } from './logger.js';
import { createSectionPoller } from './polling/sectionPoller.js';
import type { CandidateSink, SectionRepository } from './results/sectionRepository.js';
import { createSectionStore } from './results/sectionStore.js';
import { runWindow, type WindowOutcome } from './scheduler/scheduler.js';
import { createUrnaClient } from './urna/urnaClient.js';

export interface AppDependencies {
  fetch: FetchFn;
  clock: Clock;
  logger: Logger;
  repository: SectionRepository & CandidateSink;
}

export interface BackfillSummary {
  passes: number;
  restored: number;
  fetched: number;
  /** Left for a later run: published but not totalized yet, unreadable, or failed after retries. */
  pending: number;
  invalid: number;
  failed: number;
  stored: number;
  aborted: boolean;
}

export interface App {
  /** MODE=job: periodic jobs inside the schedule window. */
  run(signal?: AbortSignal): Promise<WindowOutcome>;
  /** MODE=backfill: jobs back to back, ignoring the window, until nothing is deferred; then one CSV. */
  backfill(signal?: AbortSignal): Promise<BackfillSummary>;
}

export const USER_AGENT = 'elections-data-worker/1.0 (+https://github.com/DidiProjects/ElectionsData)';
const MAX_RETRY_DELAY_MS = 30_000;

export function createApp(config: AppConfig, deps: AppDependencies): App {
  const { clock, logger } = deps;

  const http = createHttpClient({
    fetch: deps.fetch,
    clock,
    logger,
    gate: createCooldownGate(clock),
    maxRetries: config.maxRetries,
    baseDelayMs: config.retryBaseDelayMs,
    maxDelayMs: MAX_RETRY_DELAY_MS,
    timeoutMs: config.requestTimeoutMs,
    userAgent: USER_AGENT,
  });
  const client = createUrnaClient(http, config);
  const store = createSectionStore();
  const poller = createSectionPoller({
    client,
    store,
    repository: deps.repository,
    logger,
    clock,
    states: config.states,
    concurrency: config.concurrency,
    jobBudgetMs: config.pollIntervalMs,
  });
  const exporter = createExporter({
    store,
    logger,
    clock,
    names: createCandidateDirectory(client, deps.repository, logger),
    writer: createVersionedCsvWriter({
      outputDir: config.outputDir,
      prefix: config.outputPrefix,
      maxVersions: config.maxVersions,
    }),
    officeCodes: config.officeCodes,
  });

  return {
    run: (signal) =>
      runWindow({
        clock,
        logger,
        signal,
        window: { start: config.scheduleStart, end: config.scheduleEnd },
        tasks: [
          {
            name: 'sections',
            intervalMs: config.pollIntervalMs,
            run: async (taskSignal) => {
              const stats = await poller.pollOnce(taskSignal);
              logger.info('job finished', { ...stats });
              await exporter.exportAll();
            },
          },
        ],
      }),

    async backfill(signal) {
      const summary: BackfillSummary = {
        passes: 0,
        restored: 0,
        fetched: 0,
        pending: 0,
        invalid: 0,
        failed: 0,
        stored: 0,
        aborted: false,
      };
      // Each pass is still bounded by the job budget, so progress is persisted as it goes.
      for (;;) {
        const stats = await poller.pollOnce(signal);
        summary.passes++;
        summary.restored += stats.restored;
        summary.fetched += stats.fetched;
        logger.info('backfill pass finished', { pass: summary.passes, ...stats });
        if (signal?.aborted || stats.deferred === 0) {
          summary.pending = stats.pending;
          summary.invalid = stats.invalid;
          summary.failed = stats.failed;
          summary.stored = stats.stored;
          summary.aborted = signal?.aborted ?? false;
          break;
        }
      }
      await exporter.exportAll();
      logger.info('backfill finished', { ...summary });
      return summary;
    },
  };
}
