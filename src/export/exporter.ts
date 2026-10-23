import type { Logger } from '../logger.js';
import type { ResultStore } from '../results/resultStore.js';
import { serializeCsv, toCsvRows } from './csv.js';
import type { VersionedCsvWriter } from './versionedCsvWriter.js';

export interface Exporter {
  exportAll(): Promise<void>;
}

export interface ExporterOptions {
  store: ResultStore;
  writer: VersionedCsvWriter;
  logger: Logger;
  cycle: string;
  electionCode: number;
  officeCodes: number[];
}

export function csvPrefix(cycle: string, electionCode: number, officeCode: number): string {
  return `${cycle}_e${String(electionCode).padStart(6, '0')}_c${String(officeCode).padStart(4, '0')}`;
}

export function createExporter(options: ExporterOptions): Exporter {
  const exportedRevision = new Map<number, number>();

  return {
    async exportAll() {
      for (const officeCode of options.officeCodes) {
        const revision = options.store.revision(officeCode);
        if (revision === 0 || exportedRevision.get(officeCode) === revision) continue;

        const results = options.store.byOffice(officeCode);
        const prefix = csvPrefix(options.cycle, options.electionCode, officeCode);
        try {
          const outcome = await options.writer.write(prefix, serializeCsv(toCsvRows(results)));
          exportedRevision.set(officeCode, revision);
          if (outcome.written) {
            options.logger.info('csv version written', {
              file: outcome.filePath,
              municipalities: results.length,
              pruned: outcome.pruned.length,
            });
          }
        } catch (error) {
          options.logger.error('csv export failed, will retry next run', {
            prefix,
            error: (error as Error).message,
          });
        }
      }
    },
  };
}
