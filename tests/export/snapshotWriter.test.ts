import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotWriter, formatSnapshotTimestamp } from '../../src/export/snapshotWriter.js';
import { FakeClock } from '../helpers.js';

describe('formatSnapshotTimestamp', () => {
  it('produces a compact, sortable UTC stamp', () => {
    expect(formatSnapshotTimestamp(new Date('2026-10-25T20:30:15.123Z'))).toBe('20261025T203015123Z');
  });
});

describe('createSnapshotWriter', () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-writer-'));
    clock = new FakeClock('2026-10-25T20:00:00.000Z');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return fs.rm(dir, { recursive: true, force: true });
  });

  const read = (...parts: string[]) => fs.readFile(path.join(dir, ...parts), 'utf8');
  const files = [
    { name: 'a.csv', content: 'A1' },
    { name: 'b.csv', content: 'B1' },
  ];

  it('writes every file into a timestamped folder and at the root', async () => {
    const outputDir = path.join(dir, 'nested');
    const outcome = await createSnapshotWriter({ outputDir, clock }).write(files);
    expect(outcome).toEqual({
      snapshotDir: path.join(outputDir, '20261025T200000000Z'),
      latestPaths: [path.join(outputDir, 'a.csv'), path.join(outputDir, 'b.csv')],
    });
    expect((await fs.readdir(outputDir)).sort()).toEqual(['20261025T200000000Z', 'a.csv', 'b.csv']);
    expect((await fs.readdir(outcome.snapshotDir)).sort()).toEqual(['a.csv', 'b.csv']);
    expect(await fs.readFile(path.join(outcome.snapshotDir, 'a.csv'), 'utf8')).toBe('A1');
    expect(await fs.readFile(path.join(outputDir, 'b.csv'), 'utf8')).toBe('B1');
  });

  it('creates a new folder per job even when the content is identical, and keeps them all', async () => {
    const writer = createSnapshotWriter({ outputDir: dir, clock });
    for (let i = 0; i < 25; i++) {
      await writer.write(files);
      clock.advance(1000);
    }
    const folders = (await fs.readdir(dir)).filter((f) => !f.endsWith('.csv'));
    expect(folders).toHaveLength(25);
  });

  it('replaces the root files with the newest job', async () => {
    const writer = createSnapshotWriter({ outputDir: dir, clock });
    await writer.write(files);
    clock.advance(1000);
    await writer.write([{ name: 'a.csv', content: 'A2' }]);
    expect(await read('a.csv')).toBe('A2');
    expect(await read('20261025T200000000Z', 'a.csv')).toBe('A1');
    expect(await read('20261025T200001000Z', 'a.csv')).toBe('A2');
  });

  it('leaves no staging folder or temporary file behind', async () => {
    await createSnapshotWriter({ outputDir: dir, clock }).write(files);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('.') || f.endsWith('.tmp'))).toBe(false);
  });

  it('does not publish the folder or touch the root when a file fails to write', async () => {
    const writer = createSnapshotWriter({ outputDir: dir, clock });
    await writer.write(files);
    clock.advance(1000);
    const original = fs.writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('b.csv')) throw new Error('disk full');
      return original(file, ...(rest as [string, BufferEncoding]));
    });
    await expect(writer.write([{ name: 'a.csv', content: 'A2' }, { name: 'b.csv', content: 'B2' }])).rejects.toThrow('disk full');
    const visible = (await fs.readdir(dir)).filter((f) => !f.startsWith('.'));
    expect(visible.sort()).toEqual(['20261025T200000000Z', 'a.csv', 'b.csv']);
    expect(await read('a.csv')).toBe('A1');
  });
});
