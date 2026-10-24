import type { Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { createCandidateDirectory } from './export/candidateDirectory.js';
import { createExporter } from './export/exporter.js';
import { createVersionedCsvWriter } from './export/versionedCsvWriter.js';
import { createCooldownGate } from './http/cooldownGate.js';
import { createHttpClient, type FetchFn } from './http/httpClient.js';
import type { Logger } from './logger.js';
import { createSectionPoller } from './polling/sectionPoller.js';
import { createSectionStore } from './results/sectionStore.js';
import { runWindow, type WindowOutcome } from './scheduler/scheduler.js';
import { createUrnaClient } from './urna/urnaClient.js';

export interface AppDependencies {
  fetch: FetchFn;
  clock: Clock;
  logger: Logger;
}

export interface App {
  run(signal?: AbortSignal): Promise<WindowOutcome>;
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
    names: createCandidateDirectory(client, logger),
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
  };
}
