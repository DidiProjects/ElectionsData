import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVersionedCsvWriter } from '../../src/export/versionedCsvWriter.js';

describe('createVersionedCsvWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'versioned-writer-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const files = async () => (await fs.readdir(dir)).sort();
  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  const writer = (maxVersions = 1000, outputDir = dir) =>
    createVersionedCsvWriter({ outputDir, prefix: 'secoes_2t2026', maxVersions });

  it('writes version 0 and the current file, creating the directory', async () => {
    const outputDir = path.join(dir, 'nested');
    const outcome = await writer(1000, outputDir).write(['a,', 'b\n']);
    expect(outcome).toEqual({
      version: 0,
      versionPath: path.join(outputDir, 'secoes_2t2026_0.csv'),
      currentPath: path.join(outputDir, 'secoes_2t2026_current.csv'),
      pruned: [],
    });
    expect(await fs.readFile(outcome.versionPath, 'utf8')).toBe('a,b\n');
    expect(await fs.readFile(outcome.currentPath, 'utf8')).toBe('a,b\n');
  });

  it('increments the counter on every write, even with identical content', async () => {
    const w = writer();
    for (let i = 0; i < 3; i++) await w.write(['same']);
    expect(await files()).toEqual(['secoes_2t2026_0.csv', 'secoes_2t2026_1.csv', 'secoes_2t2026_2.csv', 'secoes_2t2026_current.csv']);
  });

  it('keeps the current file on the newest version', async () => {
    const w = writer();
    await w.write(['one']);
    await w.write(['two']);
    expect(await read('secoes_2t2026_current.csv')).toBe('two');
  });

  it('keeps at most maxVersions numbered files and never counts or prunes current', async () => {
    const w = writer(3);
    for (let i = 0; i < 5; i++) await w.write([String(i)]);
    expect(await files()).toEqual(['secoes_2t2026_2.csv', 'secoes_2t2026_3.csv', 'secoes_2t2026_4.csv', 'secoes_2t2026_current.csv']);
  });

  it('reports pruned files', async () => {
    const w = writer(1);
    await w.write(['0']);
    expect((await w.write(['1'])).pruned).toEqual(['secoes_2t2026_0.csv']);
  });

  it('continues numbering from the files on disk after a restart', async () => {
    await writer().write(['0']);
    await writer().write(['1']);
    expect((await writer().write(['2'])).version).toBe(2);
  });

  it('orders versions numerically, not alphabetically', async () => {
    for (const n of [2, 9, 10]) await fs.writeFile(path.join(dir, `secoes_2t2026_${n}.csv`), String(n));
    const outcome = await writer(2).write(['11']);
    expect(outcome.version).toBe(11);
    expect(outcome.pruned).toEqual(['secoes_2t2026_2.csv', 'secoes_2t2026_9.csv']);
  });

  it('ignores files from other prefixes and unrelated names', async () => {
    await fs.writeFile(path.join(dir, 'secoes_1t2026_7.csv'), 'other');
    await fs.writeFile(path.join(dir, 'secoes_2t2026_x.csv'), 'other');
    expect((await writer(1).write(['a'])).version).toBe(0);
    expect(await files()).toContain('secoes_1t2026_7.csv');
  });

  it('streams large content in chunks', async () => {
    const line = `${'x'.repeat(1023)}\n`;
    const chunks = Array.from({ length: 3000 }, () => line);
    await writer().write(chunks);
    expect((await fs.stat(path.join(dir, 'secoes_2t2026_0.csv'))).size).toBe(3000 * 1024);
  });

  it('publishes nothing and cleans up when the content fails mid-stream', async () => {
    function* failing(): Generator<string> {
      yield 'partial';
      throw new Error('boom');
    }
    await expect(writer().write(failing())).rejects.toThrow('boom');
    expect(await files()).toEqual([]);
  });
});
