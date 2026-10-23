import type { Logger } from '../logger.js';
import type { ResultStore } from '../results/resultStore.js';
import { serializeCsv, toCsvRows } from './csv.js';
import type { CsvFile, SnapshotWriter } from './snapshotWriter.js';

export interface Exporter {
  exportAll(): Promise<void>;
}

export interface ExporterOptions {
  store: ResultStore;
  writer: SnapshotWriter;
  logger: Logger;
  cycle: string;
  electionCode: number;
  officeCodes: number[];
}

export function csvFileName(cycle: string, electionCode: number, officeCode: number): string {
  return `${cycle}_e${String(electionCode).padStart(6, '0')}_c${String(officeCode).padStart(4, '0')}.csv`;
}

export function createExporter(options: ExporterOptions): Exporter {
  return {
    async exportAll() {
      const files: CsvFile[] = [];
      const municipalities: Record<string, number> = {};
      for (const officeCode of options.officeCodes) {
        const results = options.store.byOffice(officeCode);
        // An office with only confirmed 404s (e.g. no runoff anywhere) has nothing to publish.
        if (results.length === 0) continue;
        const name = csvFileName(options.cycle, options.electionCode, officeCode);
        municipalities[name] = results.length;
        files.push({ name, content: serializeCsv(toCsvRows(results)) });
      }
      if (files.length === 0) return;

      try {
        const outcome = await options.writer.write(files);
        options.logger.info('snapshot written', {
          snapshot: outcome.snapshotDir,
          municipalities,
        });
      } catch (error) {
        options.logger.error('snapshot export failed, will retry next job', { error: (error as Error).message });
      }
    },
  };
}
