import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import { createJsonLogger, type LogLevel } from './logger.js';

const logger = createJsonLogger((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      logger.info('shutdown requested', { signal: sig });
      controller.abort();
    });
  }

  logger.info('starting', {
    cycle: config.cycle,
    pleitoCode: config.pleitoCode,
    officeCodes: config.officeCodes,
    states: config.states,
    outputPrefix: config.outputPrefix,
    outputDir: config.outputDir,
  });

  await createApp(config, { fetch, clock: systemClock, logger }).run(controller.signal);

  // Stay up after the window closes: under `restart: unless-stopped` an exit would
  // only make Docker restart the container into an immediately closed window, forever.
  while (!controller.signal.aborted) {
    await systemClock.sleep(24 * 60 * 60 * 1000, controller.signal);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error('invalid configuration', { problems: error.problems });
  } else {
    logger.error('fatal error', { error: (error as Error).stack ?? String(error) });
  }
  process.exit(1);
});
