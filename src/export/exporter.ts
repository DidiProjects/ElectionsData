import type { Clock } from '../clock.js';
import type { SectionResult } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { SectionStore } from '../results/sectionStore.js';
import type { CandidateDirectory, CandidateKey } from './candidateDirectory.js';
import { CSV_HEADER, serializeCsvRow, toCsvRows } from './csv.js';
import { formatBrasilia } from './format.js';
import type { VersionedCsvWriter } from './versionedCsvWriter.js';

export interface Exporter {
  exportAll(): Promise<void>;
}

export interface ExporterOptions {
  store: SectionStore;
  names: CandidateDirectory;
  writer: VersionedCsvWriter;
  logger: Logger;
  clock: Clock;
  officeCodes: number[];
}

function candidateKeys(results: readonly SectionResult[], officeCodes: ReadonlySet<number>): CandidateKey[] {
  const keys = new Map<string, CandidateKey>();
  for (const { section, report } of results) {
    for (const r of report.results) {
      if (!officeCodes.has(r.officeCode)) continue;
      keys.set(`${r.electionId}|${r.officeCode}|${section.state}`, {
        electionId: r.electionId,
        officeCode: r.officeCode,
        state: section.state,
      });
    }
  }
  return [...keys.values()];
}

export function createExporter(options: ExporterOptions): Exporter {
  const offices = new Set(options.officeCodes);
  return {
    async exportAll() {
      // Before the first BU is published there is nothing to report; skipping keeps
      // the evening's empty jobs from eating into the version limit.
      if (options.store.size === 0) return;

      const results = options.store.all();
      await options.names.load(candidateKeys(results, offices));
      const generatedAt = formatBrasilia(options.clock.now());
      let rows = 0;
      function* chunks(): Generator<string> {
        yield CSV_HEADER;
        for (const row of toCsvRows(results, offices, generatedAt, options.names.nameOf)) {
          rows++;
          yield serializeCsvRow(row);
        }
      }

      try {
        const outcome = await options.writer.write(chunks());
        options.logger.info('csv version written', {
          version: outcome.version,
          file: outcome.versionPath,
          current: outcome.currentPath,
          sections: results.length,
          rows,
          pruned: outcome.pruned.length,
        });
      } catch (error) {
        options.logger.error('csv export failed, will retry next job', { error: (error as Error).message });
      }
    },
  };
}
