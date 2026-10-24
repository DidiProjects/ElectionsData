import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectionResult } from '../../src/domain/types.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createSectionRepository, zoneKey } from '../../src/results/sectionRepository.js';
import { section } from '../helpers.js';

const result = (sectionNumber: string, overrides: Parameters<typeof section>[0] = {}): SectionResult => ({
  section: section({ section: sectionNumber, ...overrides }),
  hash: `h${sectionNumber}`,
  report: {
    municipality: 1066,
    zone: 4,
    section: Number(sectionNumber),
    emittedAt: '20261025T170200',
    openedAt: '20261025T080000',
    closedAt: '20261025T170000',
    results: [{ electionId: 6258, officeCode: 1, eligible: 10, turnout: 9, votes: [{ type: 'nominal', number: 13, votes: 9 }] }],
  },
});

const ZONE = { state: 'ac', municipalityCode: '01066', zone: '0004' };

describe('createSectionRepository', () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-'));
    logger = { ...silentLogger, warn: vi.fn() };
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const repo = (pleitoCode = 3221) => createSectionRepository({ stateDir: dir, pleitoCode, logger });

  it('builds zone keys', () => {
    expect(zoneKey(ZONE)).toBe('ac-01066-0004');
  });

  it('returns nothing when the state directory is empty or missing', async () => {
    await expect(repo().loadAll()).resolves.toEqual([]);
    await expect(createSectionRepository({ stateDir: path.join(dir, 'nope'), pleitoCode: 1, logger }).loadAll()).resolves.toEqual([]);
  });

  it('round-trips zones through one file per zone, per pleito', async () => {
    await repo().saveZone(ZONE, [result('0001'), result('0002')]);
    await repo().saveZone({ ...ZONE, zone: '0005' }, [result('0003', { zone: '0005' })]);
    expect((await fs.readdir(path.join(dir, 'p3221', 'ac'))).sort()).toEqual(['01066-0004.json', '01066-0005.json']);
    const loaded = await repo().loadAll();
    expect(loaded.map((r) => r.hash).sort()).toEqual(['h0001', 'h0002', 'h0003']);
    expect(loaded.find((r) => r.hash === 'h0001')).toEqual(result('0001'));
  });

  it('replaces a zone file on save, leaving no temp file', async () => {
    await repo().saveZone(ZONE, [result('0001')]);
    await repo().saveZone(ZONE, [result('0001'), result('0002')]);
    expect(await repo().loadAll()).toHaveLength(2);
    expect(await fs.readdir(path.join(dir, 'p3221', 'ac'))).toEqual(['01066-0004.json']);
  });

  it('keeps pleitos apart', async () => {
    await repo(3220).saveZone(ZONE, [result('0001')]);
    await expect(repo(3221).loadAll()).resolves.toEqual([]);
  });

  it.each([
    ['broken JSON', '{"version":1,'],
    ['another file version', JSON.stringify({ version: 2, pleitoCode: 3221, sections: [] })],
    ['another pleito', JSON.stringify({ version: 1, pleitoCode: 3220, sections: [] })],
    ['sections not an array', JSON.stringify({ version: 1, pleitoCode: 3221, sections: {} })],
    ['a section that is not an object', JSON.stringify({ version: 1, pleitoCode: 3221, sections: ['x'] })],
    ['a malformed section', JSON.stringify({ version: 1, pleitoCode: 3221, sections: [{ hash: 'h', section: {}, report: {} }] })],
    ['a section never published', JSON.stringify({ version: 1, pleitoCode: 3221, sections: [{ ...result('0001'), section: section({ publishedAt: null }) }] })],
    ['a report without results', JSON.stringify({ version: 1, pleitoCode: 3221, sections: [{ ...result('0001'), report: {} }] })],
  ])('skips a file with %s and keeps the others', async (_label, content) => {
    await repo().saveZone(ZONE, [result('0001')]);
    await fs.writeFile(path.join(dir, 'p3221', 'ac', '01066-0009.json'), content);
    await fs.writeFile(path.join(dir, 'p3221', 'ac', 'notes.txt'), 'ignored');
    expect((await repo().loadAll()).map((r) => r.hash)).toEqual(['h0001']);
    expect(logger.warn).toHaveBeenCalledWith('ignoring unreadable state file', expect.objectContaining({ file: expect.stringContaining('01066-0009.json') }));
  });
});
