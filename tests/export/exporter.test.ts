import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateDirectory } from '../../src/export/candidateDirectory.js';
import { CSV_HEADER } from '../../src/export/csv.js';
import { createExporter } from '../../src/export/exporter.js';
import type { VersionedCsvWriter } from '../../src/export/versionedCsvWriter.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createSectionStore, type SectionStore } from '../../src/results/sectionStore.js';
import { FakeClock, section } from '../helpers.js';

describe('createExporter', () => {
  let store: SectionStore;
  let written: string[];
  let write: ReturnType<typeof vi.fn<VersionedCsvWriter['write']>>;
  let names: CandidateDirectory & { load: ReturnType<typeof vi.fn> };
  let logger: Logger;
  const clock = new FakeClock('2026-10-25T00:15:00Z');

  const exporter = (officeCodes = [1]) => createExporter({ store, names, writer: { write }, logger, clock, officeCodes });

  const addSection = (sectionNumber: string, offices: Array<[number, number]> = [[6258, 1]]) =>
    store.set({
      section: section({ section: sectionNumber, state: 'al' }),
      hash: 'h',
      report: {
        municipality: 1066,
        zone: 4,
        section: Number(sectionNumber),
        emittedAt: '',
        openedAt: '',
        closedAt: '',
        results: offices.map(([electionId, officeCode]) => ({
          electionId,
          officeCode,
          eligible: 10,
          turnout: 9,
          votes: [{ type: 'nominal' as const, number: 13, votes: 9 }],
        })),
      },
    });

  beforeEach(() => {
    store = createSectionStore();
    written = [];
    write = vi.fn<VersionedCsvWriter['write']>(async (chunks) => {
      written.push([...chunks].join(''));
      return { version: 7, versionPath: '/out/s_7.csv', currentPath: '/out/s_current.csv', pruned: ['/out/s_0.csv'] };
    });
    names = { load: vi.fn(async () => undefined), nameOf: () => 'LULA' };
    logger = { ...silentLogger, info: vi.fn(), error: vi.fn() };
  });

  it('writes nothing before any BU is stored', async () => {
    await exporter().exportAll();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the header plus every stored section with Brasília generation time', async () => {
    addSection('0001');
    addSection('0002');
    await exporter().exportAll();
    const lines = (written[0] ?? '').trimEnd().split('\n');
    expect(`${lines[0]}\n`).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('2026-10-24 21:15:00,AL,01066,')).toBe(true);
    expect(lines[1]).toContain(',13,LULA,9,');
    expect(logger.info).toHaveBeenCalledWith('csv version written', {
      version: 7,
      file: '/out/s_7.csv',
      current: '/out/s_current.csv',
      sections: 2,
      rows: 2,
      pruned: 1,
    });
  });

  it('loads candidate names only for configured offices present in the BUs', async () => {
    addSection('0001', [
      [6258, 1],
      [6260, 3],
    ]);
    await exporter([1]).exportAll();
    expect(names.load).toHaveBeenCalledWith([{ electionId: 6258, officeCode: 1, state: 'al' }]);
  });

  it('writes a new version on every call', async () => {
    addSection('0001');
    const e = exporter();
    await e.exportAll();
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('logs failures and tries again next job', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    addSection('0001');
    await exporter().exportAll();
    expect(logger.error).toHaveBeenCalledWith('csv export failed, will retry next job', { error: 'disk full' });
  });
});
