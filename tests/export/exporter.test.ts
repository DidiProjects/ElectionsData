import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_COLUMNS } from '../../src/export/csv.js';
import { createExporter, csvFileName } from '../../src/export/exporter.js';
import type { SnapshotWriter } from '../../src/export/snapshotWriter.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createResultStore, type ResultStore } from '../../src/results/resultStore.js';
import { mapMunicipalityResult } from '../../src/tse/mapper.js';
import { municipality, rawResult } from '../helpers.js';

describe('csvFileName', () => {
  it('pads election and office codes', () => {
    expect(csvFileName('ele2026', 6258, 1)).toBe('ele2026_e006258_c0001.csv');
  });
});

describe('createExporter', () => {
  let store: ResultStore;
  let write: ReturnType<typeof vi.fn<SnapshotWriter['write']>>;
  let logger: Logger;

  const exporter = (officeCodes = [1, 3]) =>
    createExporter({ store, writer: { write }, logger, cycle: 'ele2026', electionCode: 6258, officeCodes });

  const addResult = (officeCode = 1, code = '01007') => {
    const m = municipality({ code });
    const raw = rawResult({ cdabr: code, carg: [{ ...rawResult().carg[0]!, cd: String(officeCode) }] });
    store.update({ municipality: m, officeCode }, mapMunicipalityResult(raw, m, officeCode), null);
  };

  beforeEach(() => {
    store = createResultStore();
    write = vi.fn<SnapshotWriter['write']>(async () => ({ snapshotDir: '/out/20261025T200000000Z', latestPaths: [] }));
    logger = { ...silentLogger, info: vi.fn(), error: vi.fn() };
  });

  it('writes nothing when no office has results', async () => {
    await exporter().exportAll();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes one snapshot with one CSV per office that has results', async () => {
    addResult(1, '01007');
    addResult(1, '01008');
    addResult(3, '01007');
    await exporter().exportAll();
    expect(write).toHaveBeenCalledTimes(1);
    const files = write.mock.calls[0]?.[0] ?? [];
    expect(files.map((f) => f.name)).toEqual(['ele2026_e006258_c0001.csv', 'ele2026_e006258_c0003.csv']);
    expect(files[0]?.content.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
    expect(files[0]?.content.trimEnd().split('\n')).toHaveLength(5);
    expect(logger.info).toHaveBeenCalledWith('snapshot written', {
      snapshot: '/out/20261025T200000000Z',
      municipalities: { 'ele2026_e006258_c0001.csv': 2, 'ele2026_e006258_c0003.csv': 1 },
    });
  });

  it('skips offices without results', async () => {
    addResult(1);
    await exporter().exportAll();
    expect(write.mock.calls[0]?.[0].map((f) => f.name)).toEqual(['ele2026_e006258_c0001.csv']);
  });

  it('writes a snapshot on every call, even when nothing changed', async () => {
    addResult();
    const e = exporter();
    await e.exportAll();
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toEqual(write.mock.calls[0]?.[0]);
  });

  it('logs failures and tries again on the next job', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    addResult();
    const e = exporter();
    await e.exportAll();
    expect(logger.error).toHaveBeenCalledWith('snapshot export failed, will retry next job', { error: 'disk full' });
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
