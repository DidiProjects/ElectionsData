import { describe, expect, it } from 'vitest';
import {
  mapMunicipalities,
  mapMunicipalityResult,
  parsePercent,
  toTotalizationStatus,
} from '../../src/municipal/mapper.js';
import type { RawCandidate } from '../../src/municipal/rawTypes.js';
import { municipality, rawResult } from './helpers.js';

describe('parsePercent', () => {
  it('converts decimal commas', () => expect(parsePercent('42,130670459')).toBeCloseTo(42.130670459));
  it('returns 0 for empty or garbage input', () => {
    expect(parsePercent(undefined)).toBe(0);
    expect(parsePercent('')).toBe(0);
    expect(parsePercent('n/a')).toBe(0);
  });
});

describe('toTotalizationStatus', () => {
  it.each([
    ['f', 'finished'],
    ['F', 'finished'],
    ['n', 'not_started'],
    ['p', 'in_progress'],
    ['s', 'in_progress'],
  ])('maps "%s" to %s', (input, status) => expect(toTotalizationStatus(input)).toBe(status));
});

describe('mapMunicipalities', () => {
  const raw = {
    dg: '',
    hg: '',
    abr: [
      { cd: 'AC', ds: 'ACRE', mu: [{ cd: '01007', cdi: '1200138', nm: 'A' }] },
      { cd: 'zz', ds: 'EXTERIOR', mu: [{ cd: '29254', cdi: '', nm: 'B' }] },
    ],
  };

  it('returns every municipality when no state filter is set', () => {
    expect(mapMunicipalities(raw, [])).toEqual([
      { state: 'ac', code: '01007', ibgeCode: '1200138', name: 'A' },
      { state: 'zz', code: '29254', ibgeCode: '', name: 'B' },
    ]);
  });

  it('filters by state, case-insensitively', () => {
    expect(mapMunicipalities(raw, ['ZZ']).map((m) => m.code)).toEqual(['29254']);
  });
});

describe('mapMunicipalityResult', () => {
  it('maps totals and candidates, ordered by votes', () => {
    const result = mapMunicipalityResult(rawResult(), municipality(), 1);
    expect(result).toEqual({
      electionCode: 6258,
      round: 2,
      officeCode: 1,
      officeName: 'Presidente',
      municipality: municipality(),
      generationId: 100,
      generatedAt: '25/10/2026 18:00:00',
      totalizationStatus: 'in_progress',
      totalizationDate: '25/10/2026',
      totalizationTime: '17:59:00',
      sections: { total: 40, counted: 20, countedPct: 50 },
      votes: { electorate: 1000, turnout: 600, abstention: 400, valid: 500, blank: 40, null: 60 },
      candidates: [
        { number: '11', name: 'CANDIDATA UM', ballotName: 'UM', party: 'AAA', coalition: 'AAA/BBB', votes: 300, votesPct: 60.5, status: '', elected: false },
        { number: '22', name: 'CANDIDATO DOIS', ballotName: 'DOIS', party: 'CCC', coalition: 'CCC', votes: 200, votesPct: 39.5, status: '', elected: false },
      ],
    });
  });

  it('only treats "Eleito…" statuses as elected, not runoff qualifiers', () => {
    const cand = (n: string, st: string): RawCandidate => ({ n, nm: n, nmu: n, st, e: 's', vap: n, pvap: '1,5' });
    const raw = rawResult({
      carg: [
        {
          cd: '6',
          nmn: 'Deputado Federal',
          agr: [{ par: [{ sg: 'X', cand: [cand('1', 'Eleito por QP'), cand('2', 'Eleito por média'), cand('3', '2º turno'), cand('4', 'Não eleito'), cand('5', 'Suplente')] }, { sg: 'Y' }] }],
        },
      ],
    });
    const result = mapMunicipalityResult(raw, municipality(), 6);
    expect(result.candidates.map((c) => [c.number, c.elected])).toEqual([
      ['5', false],
      ['4', false],
      ['3', false],
      ['2', true],
      ['1', true],
    ]);
    expect(result.candidates[0]?.coalition).toBe('');
    expect(result.candidates[0]?.votesPct).toBe(1.5);
  });

  it('breaks vote ties by candidate number', () => {
    const raw = rawResult();
    for (const agr of raw.carg[0]?.agr ?? []) for (const par of agr.par) for (const c of par.cand ?? []) c.vap = '0';
    expect(mapMunicipalityResult(raw, municipality(), 1).candidates.map((c) => c.number)).toEqual(['11', '22']);
  });

  it('derives the counted percentage when TSE omits it', () => {
    expect(mapMunicipalityResult(rawResult({ s: { ts: '8', st: '2' } }), municipality(), 1).sections.countedPct).toBe(25);
    expect(mapMunicipalityResult(rawResult({ s: { ts: '0', st: '0' } }), municipality(), 1).sections.countedPct).toBe(0);
  });

  it('defaults missing candidate status to empty', () => {
    const raw = rawResult();
    delete raw.carg[0]?.agr[0]?.par[0]?.cand?.[0]?.st;
    expect(mapMunicipalityResult(raw, municipality(), 1).candidates[0]?.status).toBe('');
  });

  it('throws when the office is missing', () => {
    expect(() => mapMunicipalityResult(rawResult(), municipality(), 3)).toThrow(/office 3 missing/);
  });
});
