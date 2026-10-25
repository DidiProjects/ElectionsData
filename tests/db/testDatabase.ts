import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describe } from 'vitest';
import { createDatabase, type Database } from '../../src/db/database.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Database tests run only with TEST_DATABASE_URL; without it they are reported as skipped. */
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export interface TestDatabase {
  db: Database;
  schema: string;
  drop(): Promise<void>;
}

/** A throwaway schema per call, so test files can run in parallel against one server. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase({ connectionString: TEST_DATABASE_URL as string, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createDatabase({ connectionString: TEST_DATABASE_URL as string, searchPath: schema });
  return {
    db,
    schema,
    async drop() {
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
