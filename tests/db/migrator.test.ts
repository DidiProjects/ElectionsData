import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrator.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createTestDatabase, describeDb, MIGRATIONS_DIR, type TestDatabase } from './testDatabase.js';

describeDb('runMigrations', () => {
  let t: TestDatabase;
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    t = await createTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    logger = { ...silentLogger, info: vi.fn() };
  });
  afterEach(async () => {
    await t.drop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('applies the project migrations and exposes the view', async () => {
    expect(await runMigrations(t.db, MIGRATIONS_DIR, logger)).toEqual(['001_initial.sql']);
    const tables = await t.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [t.schema],
    );
    expect(tables.map((r) => r.table_name)).toEqual(['candidato', 'resultado_cargo', 'schema_migrations', 'secao', 'voto', 'votos_secao']);
    expect(logger.info).toHaveBeenCalledWith('migration applied', { file: '001_initial.sql' });
  });

  it('is idempotent and applies only new files, in name order', async () => {
    await fs.writeFile(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id int);');
    await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);');
    await fs.writeFile(path.join(dir, 'README.md'), 'not a migration');
    expect(await runMigrations(t.db, dir, logger)).toEqual(['001_a.sql', '002_b.sql']);
    expect(await runMigrations(t.db, dir, logger)).toEqual([]);
    await fs.writeFile(path.join(dir, '003_c.sql'), 'CREATE TABLE c (id int);');
    expect(await runMigrations(t.db, dir, logger)).toEqual(['003_c.sql']);
  });

  it('rolls back everything when a migration fails', async () => {
    await fs.writeFile(path.join(dir, '001_ok.sql'), 'CREATE TABLE ok (id int);');
    await fs.writeFile(path.join(dir, '002_bad.sql'), 'CREATE TABLE nope (;');
    await expect(runMigrations(t.db, dir, logger)).rejects.toThrow();
    const rows = await t.db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'ok'`, [t.schema]);
    expect(rows).toEqual([]);
  });
});
