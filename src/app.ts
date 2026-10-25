import path from 'node:path';
import type { Clock } from './clock.js';
import type { AppConfig, Collector } from './config.js';
import { createCandidateDirectory } from './export/candidateDirectory.js';
import { createExporter } from './export/exporter.js';
import { createVersionedCsvWriter } from './export/versionedCsvWriter.js';
import { createCooldownGate } from './http/cooldownGate.js';
import { createHttpClient, type FetchFn } from './http/httpClient.js';
import type { Logger } from './logger.js';
import { createMunicipalCollector } from './municipal/collector.js';
import { createSectionPoller } from './polling/sectionPoller.js';
import type { CandidateSink, SectionRepository } from './results/sectionRepository.js';
import { createSectionStore } from './results/sectionStore.js';
import { runWindow, type ScheduledTask, type WindowOutcome } from './scheduler/scheduler.js';
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

/** "secoes" + "2t2026" -> "secoes_2t2026"; no tag -> "secoes". */
export const fileName = (kind: string, tag: string): string => (tag ? `${kind}_${tag}` : kind);

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
      outputDir: path.join(config.outputDir, 'secoes'),
      prefix: fileName('secoes', config.outputTag),
      maxVersions: config.maxVersions,
    }),
    officeCodes: config.officeCodes,
  });
  const municipal = createMunicipalCollector({
    http,
    logger,
    writer: createVersionedCsvWriter({
      outputDir: path.join(config.outputDir, 'municipios'),
      prefix: fileName('municipios', config.outputTag),
      maxVersions: config.maxVersions,
    }),
    baseUrl: config.baseUrl,
    cycle: config.cycle,
    pleitoCode: config.pleitoCode,
    officeCodes: config.officeCodes,
    states: config.states,
    concurrency: config.concurrency,
  });

  return {
    run: (signal) =>
      runWindow({
        clock,
        logger,
        signal,
        window: { start: config.scheduleStart, end: config.scheduleEnd },
        // Independent tasks: a slow BU batch never delays the live municipality partials.
        tasks: (
          [
            {
              collector: 'secoes',
              name: 'sections',
              intervalMs: config.pollIntervalMs,
              run: async (taskSignal) => {
                const stats = await poller.pollOnce(taskSignal);
                logger.info('job finished', { ...stats });
                await exporter.exportAll();
              },
            },
            {
              collector: 'municipios',
              name: 'municipalities',
              intervalMs: config.pollIntervalMs,
              run: async (taskSignal) => {
                const stats = await municipal.runJob(taskSignal);
                logger.info('municipal job finished', { complete: stats.complete, elections: stats.elections });
              },
            },
          ] satisfies Array<ScheduledTask & { collector: Collector }>
        )
          .filter((task) => config.collectors.includes(task.collector))
          .map(({ collector: _collector, ...task }) => task),
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
