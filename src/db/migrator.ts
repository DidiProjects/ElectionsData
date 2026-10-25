import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';
import type { Database } from './database.js';

// Arbitrary constant: serializes migrations if two workers ever start at once.
const MIGRATION_LOCK = 4_202_610;

/** Applies every `NNN_*.sql` file not yet recorded in schema_migrations, in name order. */
export async function runMigrations(db: Database, dir: string, logger: Logger): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set((await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    for (const file of pending) {
      await tx.query(await fs.readFile(path.join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      logger.info('migration applied', { file });
    }
    return pending;
  });
}
