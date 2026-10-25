import type { BallotBoxReport } from '../urna/bu.js';

export interface Section {
  /** Lowercase UF code; "zz" is abroad. */
  state: string;
  municipalityCode: string;
  municipalityName: string;
  zone: string;
  section: string;
  /** Sections aggregated into this one (their votes are in this BU). */
  aggregated: string[];
  /** When the TSE published this section's BU ("dd/mm/yyyy hh:mm:ss"); null while unavailable. */
  publishedAt: string | null;
}

export interface SectionResult {
  section: Section;
  hash: string;
  report: BallotBoxReport;
}
