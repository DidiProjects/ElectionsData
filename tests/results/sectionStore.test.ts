import { describe, expect, it } from 'vitest';
import type { SectionResult } from '../../src/domain/types.js';
import { createSectionStore, sectionKey } from '../../src/results/sectionStore.js';
import { section } from '../helpers.js';

const result = (overrides: Parameters<typeof section>[0] = {}, hash = 'h'): SectionResult => ({
  section: section(overrides),
  hash,
  report: { municipality: 1, zone: 1, section: 1, emittedAt: '', openedAt: '', closedAt: '', results: [] },
});

describe('createSectionStore', () => {
  it('builds keys from state, municipality, zone and section', () => {
    expect(sectionKey(section())).toBe('ac-01066-0004-0077');
  });

  it('stores, replaces and counts results', () => {
    const store = createSectionStore();
    expect(store.size).toBe(0);
    store.set(result({}, 'a'));
    store.set(result({}, 'b'));
    expect(store.size).toBe(1);
    expect(store.get(section())?.hash).toBe('b');
    expect(store.get(section({ section: '0099' }))).toBeUndefined();
  });

  it('lists results ordered by state, municipality, zone and section', () => {
    const store = createSectionStore();
    store.set(result({ state: 'sp' }));
    store.set(result({ section: '0100' }));
    store.set(result({ zone: '0001' }));
    store.set(result({ section: '0001' }));
    store.set(result({ section: '0001' }));
    expect(store.all().map((r) => sectionKey(r.section))).toEqual([
      'ac-01066-0001-0077',
      'ac-01066-0004-0001',
      'ac-01066-0004-0100',
      'sp-01066-0004-0077',
    ]);
  });
});
