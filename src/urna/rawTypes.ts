/**
 * Subset of the TSE "arquivo-urna" JSON files consumed by this worker.
 * Field names are the TSE's own abbreviations; every value arrives as a string.
 */

export interface RawSection {
  ns: string;
  /** Sections aggregated into this one: their votes are inside this section's BU. */
  nsa?: string[];
  /** Set on an aggregated section: the principal section that carries its BU. */
  nsp?: string;
  /** Publication date/time of the BU; absent until the BU is available. */
  da?: string;
  ha?: string;
}

export interface RawSectionList {
  cdp: string;
  abr: Array<{
    cd: string;
    mu: Array<{
      cd: string;
      nm: string;
      zon: Array<{ cd: string; sec: RawSection[] }>;
    }>;
  }>;
}

export interface RawAuxFile {
  st: string;
  hashes: Array<{
    hash: string;
    dr: string;
    hr: string;
    st: string;
    arq: Array<{ nm: string; tp: string }>;
  }>;
}

export interface RawCandidateFile {
  carg: Array<{
    agr: Array<{ par: Array<{ cand?: Array<{ n: string; nmu: string }> }> }>;
  }>;
}
