import { describe, expect, it } from 'vitest';
import { isRawMunicipalityConfig, isRawTrackingFile, isValidMunicipalityResult } from '../../src/tse/guards.js';
import { rawResult, rawTracking } from '../helpers.js';

const expected = { electionCode: 6258, municipalityCode: '01007', officeCode: 1 };

describe('isRawMunicipalityConfig', () => {
  it('accepts a well-formed list', () => {
    expect(
      isRawMunicipalityConfig({ dg: '', hg: '', abr: [{ cd: 'ac', ds: 'ACRE', mu: [{ cd: '1', cdi: '2', nm: 'X' }] }] }),
    ).toBe(true);
  });

  it.each([null, [], { abr: 'x' }, { abr: [{ cd: 'ac' }] }, { abr: [{ cd: 'ac', mu: [{ cd: '1' }] }] }])(
    'rejects %j',
    (value) => expect(isRawMunicipalityConfig(value)).toBe(false),
  );
});

describe('isRawTrackingFile', () => {
  it('accepts a well-formed tracking file', () => {
    expect(isRawTrackingFile(rawTracking([{ code: '01007' }]))).toBe(true);
  });

  it.each([null, { ele: '1' }, { ele: '1', abr: [{ tpabr: 'mun' }] }, { ele: '1', abr: [{ ...rawTracking([]).abr[0], s: null }] }])(
    'rejects %j',
    (value) => expect(isRawTrackingFile(value)).toBe(false),
  );
});

describe('isValidMunicipalityResult', () => {
  it('accepts the expected file', () => {
    expect(isValidMunicipalityResult(rawResult(), expected)).toBe(true);
  });

  it('accepts parties without candidates', () => {
    const raw = rawResult();
    raw.carg[0]?.agr[0]?.par.push({ sg: 'LEG' });
    expect(isValidMunicipalityResult(raw, expected)).toBe(true);
  });

  const broken: Array<[string, unknown]> = [
    ['not an object', 'x'],
    ['a different election', rawResult({ ele: '6257' })],
    ['a different municipality', rawResult({ cdabr: '99999' })],
    ['a non-numeric generation id', rawResult({ idg: 'x' })],
    ['missing sections', { ...rawResult(), s: undefined }],
    ['non-numeric sections', rawResult({ s: { ts: '10', st: '?' } })],
    ['more counted than total sections', rawResult({ s: { ts: '10', st: '11' } })],
    ['missing electorate field', rawResult({ e: { te: '1', c: '1' } as never })],
    ['missing vote field', rawResult({ v: { vv: '1', vb: '1' } as never })],
    ['missing totalization status', { ...rawResult(), and: undefined }],
    ['offices not an array', rawResult({ carg: {} as never })],
    ['without the requested office', rawResult({ carg: [{ cd: '3', nmn: 'Governador', agr: [] }] })],
    ['a candidate with non-numeric votes', rawResult({ carg: [{ cd: '1', nmn: 'P', agr: [{ par: [{ sg: 'A', cand: [{ n: '1', nm: 'A', nmu: 'A', vap: '' }] }] }] }] })],
    ['a party without acronym', rawResult({ carg: [{ cd: '1', nmn: 'P', agr: [{ par: [{} as never] }] }] })],
  ];

  it.each(broken)('rejects %s', (_label, value) => {
    expect(isValidMunicipalityResult(value, expected)).toBe(false);
  });
});
