import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, escapeCsvField, serializeCsv, toCsvRows } from '../../src/municipal/csv.js';
import { mapMunicipalityResult } from '../../src/municipal/mapper.js';
import { municipality, rawResult } from './helpers.js';

describe('escapeCsvField', () => {
  it.each([
    ['plain', 'plain'],
    [42, '42'],
    [true, 'true'],
    ['A, B', '"A, B"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
  ])('escapes %j as %j', (input, output) => expect(escapeCsvField(input)).toBe(output));
});

describe('toCsvRows', () => {
  it('produces one row per candidate with municipality totals repeated', () => {
    const rows = toCsvRows([mapMunicipalityResult(rawResult(), municipality(), 1)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      election_code: 6258,
      round: 2,
      office_code: 1,
      office_name: 'Presidente',
      state: 'AC',
      municipality_code: '01007',
      ibge_code: '1200138',
      municipality_name: 'CIDADE TESTE',
      totalization_status: 'in_progress',
      totalization_date: '25/10/2026',
      totalization_time: '17:59:00',
      tse_generated_at: '25/10/2026 18:00:00',
      sections_total: 40,
      sections_counted: 20,
      sections_counted_pct: 50,
      electorate: 1000,
      turnout: 600,
      abstention: 400,
      valid_votes: 500,
      blank_votes: 40,
      null_votes: 60,
      candidate_number: '11',
      candidate_name: 'CANDIDATA UM',
      candidate_ballot_name: 'UM',
      party: 'AAA',
      coalition: 'AAA/BBB',
      votes: 300,
      votes_pct: 60.5,
      candidate_status: '',
      elected: false,
    });
    expect(Object.keys(rows[0] ?? {})).toEqual([...CSV_COLUMNS]);
  });
});

describe('serializeCsv', () => {
  it('writes the header even with no rows', () => {
    expect(serializeCsv([])).toBe(`${CSV_COLUMNS.join(',')}\n`);
  });

  it('writes rows in column order', () => {
    const rows = toCsvRows([mapMunicipalityResult(rawResult(), municipality({ name: 'A, B' }), 1)]);
    const lines = serializeCsv(rows).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"A, B"');
    expect(lines[1]?.startsWith('6258,2,1,Presidente,AC,01007,1200138,')).toBe(true);
  });
});
