import type { Logger } from '../logger.js';
import type { UrnaClient } from '../urna/urnaClient.js';

export interface CandidateKey {
  electionId: number;
  officeCode: number;
  state: string;
}

export interface CandidateDirectory {
  /** Loads names for keys not cached yet; a failed key stays unloaded and is retried next call. */
  load(keys: Iterable<CandidateKey>): Promise<void>;
  nameOf(electionId: number, officeCode: number, state: string, number: number): string;
}

const keyOf = (electionId: number, officeCode: number, state: string): string => `${electionId}|${officeCode}|${state}`;

export function createCandidateDirectory(client: UrnaClient, logger: Logger): CandidateDirectory {
  const cache = new Map<string, Map<number, string>>();
  return {
    async load(keys) {
      for (const { electionId, officeCode, state } of keys) {
        const key = keyOf(electionId, officeCode, state);
        if (cache.has(key)) continue;
        try {
          cache.set(key, await client.getCandidateNames(electionId, state, officeCode));
        } catch (error) {
          logger.warn('candidate names unavailable, leaving them blank for now', {
            electionId,
            officeCode,
            state,
            error: (error as Error).message,
          });
        }
      }
    },
    nameOf: (electionId, officeCode, state, number) => cache.get(keyOf(electionId, officeCode, state))?.get(number) ?? '',
  };
}
