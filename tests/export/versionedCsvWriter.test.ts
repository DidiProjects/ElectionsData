import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVersionedCsvWriter, formatVersionTimestamp } from '../../src/export/versionedCsvWriter.js';
import { FakeClock } from '../helpers.js';

describe('formatVersionTimestamp', () => {
  it('produces a compact, sortable UTC stamp', () => {
    expect(formatVersionTimestamp(new Date('2026-10-25T20:30:15.123Z'))).toBe('20261025T203015123Z');
  });
});

describe('createVersionedCsvWriter', () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-writer-'));
    clock = new FakeClock('2026-10-25T20:00:00.000Z');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const files = async () => (await fs.readdir(dir)).sort();

  it('creates the output directory and writes a timestamped file', async () => {
    const outputDir = path.join(dir, 'nested', 'out');
    const writer = createVersionedCsvWriter({ outputDir, maxVersions: 3, clock });
    const outcome = await writer.write('p', 'a\n');
    expect(outcome).toEqual({ written: true, filePath: path.join(outputDir, 'p_20261025T200000000Z.csv'), pruned: [] });
    expect(await fs.readFile(outcome.filePath as string, 'utf8')).toBe('a\n');
    expect(await fs.readdir(outputDir)).toEqual(['p_20261025T200000000Z.csv']);
  });

  it('skips content identical to the latest version', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    await writer.write('p', 'a\n');
    clock.advance(1000);
    expect(await writer.write('p', 'a\n')).toEqual({ written: false, filePath: null, pruned: [] });
    expect(await files()).toHaveLength(1);
  });

  it('compares against the newest file on disk after a restart', async () => {
    await createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock }).write('p', 'a\n');
    clock.advance(1000);
    const restarted = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    expect((await restarted.write('p', 'a\n')).written).toBe(false);
    expect((await restarted.write('p', 'b\n')).written).toBe(true);
  });

  it('keeps only the newest maxVersions files per prefix', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 2, clock });
    for (const content of ['1', '2', '3']) {
      await writer.write('p', content);
      clock.advance(1000);
    }
    await writer.write('other', 'x');
    expect(await files()).toEqual([
      'other_20261025T200003000Z.csv',
      'p_20261025T200001000Z.csv',
      'p_20261025T200002000Z.csv',
    ]);
  });

  it('reports pruned files', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 1, clock });
    await writer.write('p', '1');
    clock.advance(1000);
    expect((await writer.write('p', '2')).pruned).toEqual(['p_20261025T200000000Z.csv']);
  });

  it('ignores files from other prefixes sharing the same start and unrelated files', async () => {
    await fs.writeFile(path.join(dir, 'p_x_20261025T100000000Z.csv'), 'other');
    await fs.writeFile(path.join(dir, 'p_notes.txt'), 'keep');
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 1, clock });
    await writer.write('p', '1');
    clock.advance(1000);
    await writer.write('p', '2');
    expect(await files()).toEqual(['p_20261025T200001000Z.csv', 'p_notes.txt', 'p_x_20261025T100000000Z.csv']);
  });

  it('leaves no temporary file behind', async () => {
    await createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock }).write('p', 'a');
    expect((await files()).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
