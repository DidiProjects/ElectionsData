import type { Clock } from './clock.js';
import type { AppConfig } from './config.js';
import { createExporter } from './export/exporter.js';
import { createSnapshotWriter } from './export/snapshotWriter.js';
import { createCooldownGate } from './http/cooldownGate.js';
import { createHttpClient, type FetchFn } from './http/httpClient.js';
import type { Logger } from './logger.js';
import { createPoller } from './polling/poller.js';
import { createResultStore } from './results/resultStore.js';
import { runWindow, type WindowOutcome } from './scheduler/scheduler.js';
import { createTseClient } from './tse/tseClient.js';

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
  const client = createTseClient(http, config);
  const store = createResultStore();
  const poller = createPoller({
    client,
    store,
    logger,
    states: config.states,
    officeCodes: config.officeCodes,
    concurrency: config.concurrency,
  });
  const exporter = createExporter({
    store,
    logger,
    writer: createSnapshotWriter({ outputDir: config.outputDir, clock }),
    cycle: config.cycle,
    electionCode: config.electionCode,
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
            name: 'poll',
            intervalMs: config.pollIntervalMs,
            run: async (taskSignal) => {
              const stats = await poller.pollOnce(taskSignal);
              logger.info('poll cycle finished', { ...stats });
              // Exporting mid-sweep would publish a CSV that silently lacks municipalities.
              if (stats.complete) {
                await exporter.exportAll();
              } else {
                logger.warn('cycle left gaps, export skipped until every municipality has a value', {
                  missing: stats.missing,
                });
              }
            },
          },
        ],
      }),
  };
}
