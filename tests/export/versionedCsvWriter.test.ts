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

  const versions = async (prefix = 'p') => (await fs.readdir(path.join(dir, prefix))).sort();
  const latest = (prefix = 'p') => fs.readFile(path.join(dir, `${prefix}.csv`), 'utf8');

  it('writes a version inside the prefix folder and the fixed-name latest file beside it', async () => {
    const outputDir = path.join(dir, 'nested');
    const writer = createVersionedCsvWriter({ outputDir, maxVersions: 3, clock });
    const outcome = await writer.write('p', 'a\n');
    expect(outcome).toEqual({
      written: true,
      versionPath: path.join(outputDir, 'p', '20261025T200000000Z.csv'),
      latestPath: path.join(outputDir, 'p.csv'),
      pruned: [],
    });
    expect(await fs.readFile(outcome.versionPath as string, 'utf8')).toBe('a\n');
    expect(await fs.readFile(outcome.latestPath, 'utf8')).toBe('a\n');
    expect((await fs.readdir(outputDir)).sort()).toEqual(['p', 'p.csv']);
  });

  it('replaces the latest file with each new version', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    await writer.write('p', '1');
    clock.advance(1000);
    await writer.write('p', '2');
    expect(await latest()).toBe('2');
    expect(await versions()).toEqual(['20261025T200000000Z.csv', '20261025T200001000Z.csv']);
  });

  it('skips content identical to the latest version', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    await writer.write('p', 'a\n');
    clock.advance(1000);
    expect(await writer.write('p', 'a\n')).toEqual({
      written: false,
      versionPath: null,
      latestPath: path.join(dir, 'p.csv'),
      pruned: [],
    });
    expect(await versions()).toHaveLength(1);
  });

  it('restores a missing latest file even when the content did not change', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    await writer.write('p', 'a\n');
    await fs.rm(path.join(dir, 'p.csv'));
    expect((await writer.write('p', 'a\n')).written).toBe(false);
    expect(await latest()).toBe('a\n');
  });

  it('compares against the newest version on disk after a restart', async () => {
    await createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock }).write('p', 'a\n');
    clock.advance(1000);
    const restarted = createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock });
    expect((await restarted.write('p', 'a\n')).written).toBe(false);
    expect((await restarted.write('p', 'b\n')).written).toBe(true);
  });

  it('keeps only the newest maxVersions versions per prefix', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 2, clock });
    for (const content of ['1', '2', '3']) {
      await writer.write('p', content);
      clock.advance(1000);
    }
    await writer.write('other', 'x');
    expect(await versions()).toEqual(['20261025T200001000Z.csv', '20261025T200002000Z.csv']);
    expect(await versions('other')).toEqual(['20261025T200003000Z.csv']);
    expect(await latest()).toBe('3');
  });

  it('reports pruned versions', async () => {
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 1, clock });
    await writer.write('p', '1');
    clock.advance(1000);
    expect((await writer.write('p', '2')).pruned).toEqual(['20261025T200000000Z.csv']);
  });

  it('ignores unrelated files in the versions folder', async () => {
    await fs.mkdir(path.join(dir, 'p'));
    await fs.writeFile(path.join(dir, 'p', 'notes.txt'), 'keep');
    const writer = createVersionedCsvWriter({ outputDir: dir, maxVersions: 1, clock });
    await writer.write('p', '1');
    clock.advance(1000);
    await writer.write('p', '2');
    expect(await versions()).toEqual(['20261025T200001000Z.csv', 'notes.txt']);
  });

  it('leaves no temporary file behind', async () => {
    await createVersionedCsvWriter({ outputDir: dir, maxVersions: 3, clock }).write('p', 'a');
    const all = [...(await fs.readdir(dir)), ...(await versions())];
    expect(all.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
