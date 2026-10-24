import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { runMigrations } from './db/migrator.js';
import { createJsonLogger, type LogLevel } from './logger.js';
import { createPostgresSectionRepository } from './results/postgresSectionRepository.js';

const logger = createJsonLogger((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

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
    mode: config.mode,
    cycle: config.cycle,
    pleitoCode: config.pleitoCode,
    officeCodes: config.officeCodes,
    states: config.states,
    outputPrefix: config.outputPrefix,
    outputDir: config.outputDir,
  });

  const db = createDatabase({ connectionString: config.databaseUrl });
  // A failed migration exits non-zero, which the deploy's running/0-restarts check catches.
  await runMigrations(db, MIGRATIONS_DIR, logger);
  const repository = createPostgresSectionRepository(db, config.pleitoCode);

  try {
    const app = createApp(config, { fetch, clock: systemClock, logger, repository });
    if (config.mode === 'backfill') {
      // One-off: exits when done (run it with `docker compose run --rm`, not as the service).
      await app.backfill(controller.signal);
      return;
    }

    await app.run(controller.signal);
    // Stay up after the window closes: under `restart: unless-stopped` an exit would
    // only make Docker restart the container into an immediately closed window, forever.
    while (!controller.signal.aborted) {
      await systemClock.sleep(24 * 60 * 60 * 1000, controller.signal);
    }
  } finally {
    await db.close();
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
