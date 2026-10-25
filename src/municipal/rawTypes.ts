/**
 * Subset of the TSE "resultados" JSON files consumed by this worker.
 * Field names are the TSE's own abbreviations; every value arrives as a string.
 */

export interface RawMunicipalityConfig {
  dg: string;
  hg: string;
  abr: Array<{
    cd: string;
    ds: string;
    mu: Array<{ cd: string; cdi: string; nm: string }>;
  }>;
}

export interface RawTrackingFile {
  ele: string;
  idg: string;
  abr: RawTrackingEntry[];
}

export interface RawTrackingEntry {
  /** "mun" for municipalities, "uf" for the state aggregate. */
  tpabr: string;
  cdabr: string;
  and: string;
  dt: string;
  ht: string;
  s: { st: string };
}

export interface RawCandidate {
  n: string;
  nm: string;
  nmu: string;
  st?: string;
  e?: string;
  vap: string;
  pvapn?: string;
  pvap?: string;
}

export interface RawParty {
  sg: string;
  cand?: RawCandidate[];
}

export interface RawAgreement {
  com?: string;
  nm?: string;
  par: RawParty[];
}

export interface RawOffice {
  cd: string;
  nmn: string;
  agr: RawAgreement[];
}

export interface RawSections {
  ts: string;
  st: string;
  pstn?: string;
}

export interface RawElectorate {
  te: string;
  c: string;
  a: string;
}

export interface RawVotes {
  vv: string;
  vb: string;
  tvn: string;
}

export interface RawMunicipalityResult {
  ele: string;
  t: string;
  tpabr: string;
  cdabr: string;
  dg: string;
  hg: string;
  idg: string;
  dt: string;
  ht: string;
  /** "n" not started, "p" partial, "f" finished. */
  and: string;
  carg: RawOffice[];
  s: RawSections;
  e: RawElectorate;
  v: RawVotes;
}
