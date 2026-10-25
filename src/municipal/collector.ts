import type { VersionedCsvWriter } from '../export/versionedCsvWriter.js';
import type { HttpClient } from '../http/httpClient.js';
import type { Logger } from '../logger.js';
import { serializeCsv, toCsvRows } from './csv.js';
import { loadPleitoElections, type PleitoElection } from './electionCatalog.js';
import { createPoller, type Poller, type PollStats } from './poller.js';
import { createResultStore, type ResultStore } from './resultStore.js';
import { createTseClient } from './tseClient.js';

export interface MunicipalJobStats {
  elections: Array<{ electionCode: number } & PollStats>;
  /** Every municipality of every election has a value: safe to publish. */
  complete: boolean;
}

export interface MunicipalCollector {
  /** One job: refresh every election's municipality results, then publish a version if complete. */
  runJob(signal?: AbortSignal): Promise<MunicipalJobStats>;
}

export interface MunicipalCollectorOptions {
  http: HttpClient;
  writer: VersionedCsvWriter;
  logger: Logger;
  baseUrl: string;
  cycle: string;
  pleitoCode: number;
  officeCodes: number[];
  states: string[];
  concurrency: number;
}

/**
 * Live partial results from the TSE totalization (per municipality), which move from 17h
 * while counting progresses, unlike the per-section BUs that may only appear later.
 */
export function createMunicipalCollector(options: MunicipalCollectorOptions): MunicipalCollector {
  const { http, logger } = options;
  const store: ResultStore = createResultStore();
  let pollers: Array<{ election: PleitoElection; poller: Poller }> | null = null;

  const ensurePollers = async (signal?: AbortSignal): Promise<boolean> => {
    if (pollers) return true;
    try {
      const elections = await loadPleitoElections(http, options, signal);
      pollers = elections.map((election) => ({
        election,
        poller: createPoller({
          client: createTseClient(http, { baseUrl: options.baseUrl, cycle: options.cycle, electionCode: election.electionCode }),
          store,
          logger,
          states: options.states,
          officeCodes: election.officeCodes,
          concurrency: options.concurrency,
        }),
      }));
      logger.info('municipal elections resolved', {
        elections: elections.map((e) => ({ election: e.electionCode, offices: e.officeCodes })),
      });
      return true;
    } catch (error) {
      logger.error('election list unavailable, will retry next job', { error: (error as Error).message });
      return false;
    }
  };

  const publish = async (): Promise<void> => {
    const results = options.officeCodes.flatMap((office) => store.byOffice(office));
    try {
      const outcome = await options.writer.write([serializeCsv(toCsvRows(results))]);
      logger.info('municipal csv version written', {
        version: outcome.version,
        file: outcome.versionPath,
        current: outcome.currentPath,
        municipalityResults: results.length,
        pruned: outcome.pruned.length,
      });
    } catch (error) {
      logger.error('municipal csv export failed, will retry next job', { error: (error as Error).message });
    }
  };

  return {
    async runJob(signal) {
      if (!(await ensurePollers(signal)) || !pollers) return { elections: [], complete: false };
      const elections: MunicipalJobStats['elections'] = [];
      for (const { election, poller } of pollers) {
        elections.push({ electionCode: election.electionCode, ...(await poller.pollOnce(signal)) });
      }
      // An empty pleito (no configured office) has nothing to publish either.
      const complete = elections.length > 0 && elections.every((e) => e.complete);
      if (complete) await publish();
      else logger.warn('municipal job left gaps, export skipped', { missing: elections.reduce((a, e) => a + e.missing, 0) });
      return { elections, complete };
    },
  };
}
