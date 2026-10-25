import type { MunicipalityResult } from './types.js';

export const CSV_COLUMNS = [
  'election_code',
  'round',
  'office_code',
  'office_name',
  'state',
  'municipality_code',
  'ibge_code',
  'municipality_name',
  'totalization_status',
  'totalization_date',
  'totalization_time',
  'tse_generated_at',
  'sections_total',
  'sections_counted',
  'sections_counted_pct',
  'electorate',
  'turnout',
  'abstention',
  'valid_votes',
  'blank_votes',
  'null_votes',
  'candidate_number',
  'candidate_name',
  'candidate_ballot_name',
  'party',
  'coalition',
  'votes',
  'votes_pct',
  'candidate_status',
  'elected',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Record<CsvColumn, string | number | boolean>;

export function toCsvRows(results: readonly MunicipalityResult[]): CsvRow[] {
  return results.flatMap((r) =>
    r.candidates.map((c) => ({
      election_code: r.electionCode,
      round: r.round,
      office_code: r.officeCode,
      office_name: r.officeName,
      state: r.municipality.state.toUpperCase(),
      municipality_code: r.municipality.code,
      ibge_code: r.municipality.ibgeCode,
      municipality_name: r.municipality.name,
      totalization_status: r.totalizationStatus,
      totalization_date: r.totalizationDate,
      totalization_time: r.totalizationTime,
      tse_generated_at: r.generatedAt,
      sections_total: r.sections.total,
      sections_counted: r.sections.counted,
      sections_counted_pct: r.sections.countedPct,
      electorate: r.votes.electorate,
      turnout: r.votes.turnout,
      abstention: r.votes.abstention,
      valid_votes: r.votes.valid,
      blank_votes: r.votes.blank,
      null_votes: r.votes.null,
      candidate_number: c.number,
      candidate_name: c.name,
      candidate_ballot_name: c.ballotName,
      party: c.party,
      coalition: c.coalition,
      votes: c.votes,
      votes_pct: c.votesPct,
      candidate_status: c.status,
      elected: c.elected,
    })),
  );
}

export function escapeCsvField(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => escapeCsvField(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}
