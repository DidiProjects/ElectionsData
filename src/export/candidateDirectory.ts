import type { Logger } from '../logger.js';
import type { CandidateKey, CandidateSink } from '../results/sectionRepository.js';
import type { UrnaClient } from '../urna/urnaClient.js';

export type { CandidateKey } from '../results/sectionRepository.js';

export interface CandidateDirectory {
  /** Loads names for keys not cached yet; a failed key stays unloaded and is retried next call. */
  load(keys: Iterable<CandidateKey>): Promise<void>;
  nameOf(electionId: number, officeCode: number, state: string, number: number): string;
}

const keyOf = (electionId: number, officeCode: number, state: string): string => `${electionId}|${officeCode}|${state}`;

export function createCandidateDirectory(client: UrnaClient, sink: CandidateSink, logger: Logger): CandidateDirectory {
  const cache = new Map<string, Map<number, string>>();
  return {
    async load(keys) {
      for (const key of keys) {
        const cacheKey = keyOf(key.electionId, key.officeCode, key.state);
        if (cache.has(cacheKey)) continue;
        try {
          const names = await client.getCandidateNames(key.electionId, key.state, key.officeCode);
          // Persisted so the database view can name votes; cached only once stored.
          await sink.saveCandidates(key, names);
          cache.set(cacheKey, names);
        } catch (error) {
          logger.warn('candidate names unavailable, leaving them blank for now', {
            ...key,
            error: (error as Error).message,
          });
        }
      }
    },
    nameOf: (electionId, officeCode, state, number) => cache.get(keyOf(electionId, officeCode, state))?.get(number) ?? '',
  };
}
