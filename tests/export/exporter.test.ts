import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_COLUMNS } from '../../src/export/csv.js';
import { createExporter, csvPrefix } from '../../src/export/exporter.js';
import type { VersionedCsvWriter } from '../../src/export/versionedCsvWriter.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createResultStore, type ResultStore } from '../../src/results/resultStore.js';
import { mapMunicipalityResult } from '../../src/tse/mapper.js';
import { municipality, rawResult } from '../helpers.js';

describe('csvPrefix', () => {
  it('pads election and office codes', () => {
    expect(csvPrefix('ele2026', 6258, 1)).toBe('ele2026_e006258_c0001');
  });
});

describe('createExporter', () => {
  let store: ResultStore;
  let write: ReturnType<typeof vi.fn<VersionedCsvWriter['write']>>;
  let logger: Logger;

  const exporter = (officeCodes = [1, 3]) =>
    createExporter({ store, writer: { write }, logger, cycle: 'ele2026', electionCode: 6258, officeCodes });

  const addResult = (idg = '1') =>
    store.update(
      { municipality: municipality(), officeCode: 1 },
      mapMunicipalityResult(rawResult({ idg }), municipality(), 1),
      null,
    );

  beforeEach(() => {
    store = createResultStore();
    write = vi.fn<VersionedCsvWriter['write']>(async () => ({ written: true, filePath: '/out/x.csv', pruned: [] }));
    logger = { ...silentLogger, info: vi.fn(), error: vi.fn() };
  });

  it('writes nothing for offices without results', async () => {
    await exporter().exportAll();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes one CSV per office that has results', async () => {
    addResult();
    await exporter().exportAll();
    expect(write).toHaveBeenCalledTimes(1);
    const [prefix, content] = write.mock.calls[0] ?? [];
    expect(prefix).toBe('ele2026_e006258_c0001');
    expect(content?.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
    expect(content?.trimEnd().split('\n')).toHaveLength(3);
    expect(logger.info).toHaveBeenCalledWith('csv version written', { file: '/out/x.csv', municipalities: 1, pruned: 0 });
  });

  it('skips serialization when the store has not changed since the last export', async () => {
    addResult();
    const e = exporter();
    await e.exportAll();
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(1);
    addResult('2');
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not log when the writer skipped identical content', async () => {
    write.mockResolvedValueOnce({ written: false, filePath: null, pruned: [] });
    addResult();
    await exporter().exportAll();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs failures and retries on the next run', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    addResult();
    const e = exporter();
    await e.exportAll();
    expect(logger.error).toHaveBeenCalledWith('csv export failed, will retry next run', {
      prefix: 'ele2026_e006258_c0001',
      error: 'disk full',
    });
    await e.exportAll();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
