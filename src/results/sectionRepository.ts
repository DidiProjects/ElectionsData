import type { SectionResult } from '../domain/types.js';

/** Durable copy of decoded BUs, so a restart or redeploy does not download them again. */
export interface SectionRepository {
  loadAll(): Promise<SectionResult[]>;
  /** Inserts or replaces these sections (and all their office results and votes). */
  save(results: readonly SectionResult[]): Promise<void>;
}

export interface CandidateKey {
  electionId: number;
  officeCode: number;
  state: string;
}

export interface CandidateSink {
  saveCandidates(key: CandidateKey, names: ReadonlyMap<number, string>): Promise<void>;
}
