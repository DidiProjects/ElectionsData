import { describe, expect, it } from 'vitest';
import type { PollTarget } from '../../src/domain/types.js';
import { createResultStore, targetKey } from '../../src/results/resultStore.js';
import { mapMunicipalityResult } from '../../src/tse/mapper.js';
import { municipality, rawResult } from '../helpers.js';

const target = (code = '01007', officeCode = 1): PollTarget => ({ municipality: municipality({ code }), officeCode });
const result = (idg: string, code = '01007') =>
  mapMunicipalityResult(rawResult({ idg, cdabr: code }), municipality({ code }), 1);

describe('createResultStore', () => {
  it('builds keys from state, municipality and office', () => {
    expect(targetKey(target('01007', 3))).toBe('ac01007-c3');
  });

  it('stores the first result and bumps the office revision', () => {
    const store = createResultStore();
    expect(store.revision(1)).toBe(0);
    expect(store.update(target(), result('5'), '"e"')).toBe('stored');
    expect(store.get(target())).toEqual({ result: result('5'), etag: '"e"' });
    expect(store.revision(1)).toBe(1);
  });

  it('accepts newer or equal generations', () => {
    const store = createResultStore();
    store.update(target(), result('5'), null);
    expect(store.update(target(), result('5'), null)).toBe('stored');
    expect(store.update(target(), result('6'), null)).toBe('stored');
    expect(store.get(target())?.result.generationId).toBe(6);
  });

  it('keeps the previous value when the incoming generation is older', () => {
    const store = createResultStore();
    store.update(target(), result('6'), '"new"');
    expect(store.update(target(), result('5'), '"old"')).toBe('stale');
    expect(store.get(target())).toMatchObject({ etag: '"new"', result: { generationId: 6 } });
    expect(store.revision(1)).toBe(1);
  });

  it('lists results of one office sorted by state and municipality', () => {
    const store = createResultStore();
    store.update(target('02000'), result('1', '02000'), null);
    store.update(target('01007'), result('1', '01007'), null);
    const other = { ...result('1', '01007'), officeCode: 3 };
    store.update(target('01007', 3), other, null);
    expect(store.byOffice(1).map((r) => r.municipality.code)).toEqual(['01007', '02000']);
    expect(store.byOffice(3)).toHaveLength(1);
  });

  it('sorts by state before municipality code', () => {
    const store = createResultStore();
    const sp = { municipality: municipality({ state: 'sp', code: '00001' }), officeCode: 1 };
    store.update(sp, { ...result('1'), municipality: sp.municipality }, null);
    store.update(target('09999'), result('1', '09999'), null);
    expect(store.byOffice(1).map((r) => r.municipality.state)).toEqual(['ac', 'sp']);
  });
});
