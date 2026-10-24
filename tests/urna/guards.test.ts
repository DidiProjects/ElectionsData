import { describe, expect, it } from 'vitest';
import { isRawAuxFile, isRawCandidateFile, isRawSectionList } from '../../src/urna/guards.js';
import { rawAux, rawCandidates, rawSectionList } from '../helpers.js';

describe('isRawSectionList', () => {
  it('accepts principal, aggregated and unpublished sections', () => {
    expect(
      isRawSectionList(
        rawSectionList([{ ns: '0001', nsa: ['0002'], published: '25/10/2026 21:00:00' }, { ns: '0002', nsp: '0001' }, { ns: '0003' }]),
      ),
    ).toBe(true);
  });

  const valid = rawSectionList([{ ns: '0001' }]);
  it.each([
    ['null', null],
    ['missing pleito', { abr: [] }],
    ['state without municipalities', { cdp: '1', abr: [{ cd: 'ac' }] }],
    ['municipality without name', { cdp: '1', abr: [{ cd: 'ac', mu: [{ cd: '1', zon: [] }] }] }],
    ['zone without sections', { cdp: '1', abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1' }] }] }] }],
    ['section number not a string', { ...valid, abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1', sec: [{ ns: 1 }] }] }] }] }],
    ['aggregated list of numbers', { ...valid, abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1', sec: [{ ns: '1', nsa: [2] }] }] }] }] }],
    ['principal pointer not a string', { ...valid, abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1', sec: [{ ns: '1', nsp: 2 }] }] }] }] }],
    ['publication date not a string', { ...valid, abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1', sec: [{ ns: '1', da: 1 }] }] }] }] }],
    ['publication time not a string', { ...valid, abr: [{ cd: 'ac', mu: [{ cd: '1', nm: 'X', zon: [{ cd: '1', sec: [{ ns: '1', ha: 1 }] }] }] }] }],
  ])('rejects %s', (_label, value) => {
    expect(isRawSectionList(value)).toBe(false);
  });
});

describe('isRawAuxFile', () => {
  it('accepts a well-formed aux file', () => {
    expect(isRawAuxFile(rawAux([{ hash: 'h' }]))).toBe(true);
  });

  it.each([
    ['null', null],
    ['missing status', { hashes: [] }],
    ['hash without files', { st: 'x', hashes: [{ hash: 'h', st: 'x', dr: '', hr: '' }] }],
    ['file without type', { st: 'x', hashes: [{ hash: 'h', st: 'x', dr: '', hr: '', arq: [{ nm: 'a' }] }] }],
  ])('rejects %s', (_label, value) => {
    expect(isRawAuxFile(value)).toBe(false);
  });
});

describe('isRawCandidateFile', () => {
  it('accepts a candidate file, including parties without candidates', () => {
    expect(isRawCandidateFile(rawCandidates([{ n: '13', nmu: 'A' }]))).toBe(true);
  });

  it.each([
    ['null', null],
    ['offices not an array', { carg: {} }],
    ['agreement without parties', { carg: [{ agr: [{}] }] }],
    ['candidate without ballot name', { carg: [{ agr: [{ par: [{ cand: [{ n: '1' }] }] }] }] }],
  ])('rejects %s', (_label, value) => {
    expect(isRawCandidateFile(value)).toBe(false);
  });
});
