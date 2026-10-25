import type { Municipality } from '../../src/municipal/types.js';
import type { RawMunicipalityResult, RawTrackingFile } from '../../src/municipal/rawTypes.js';

export { emptyResponse, FakeClock, jsonResponse } from '../helpers.js';

export const municipality = (overrides: Partial<Municipality> = {}): Municipality => ({
  state: 'ac',
  code: '01007',
  ibgeCode: '1200138',
  name: 'CIDADE TESTE',
  ...overrides,
});

export function rawResult(overrides: Partial<RawMunicipalityResult> = {}): RawMunicipalityResult {
  return {
    ele: '6258',
    t: '2',
    tpabr: 'mu',
    cdabr: '01007',
    dg: '25/10/2026',
    hg: '18:00:00',
    idg: '100',
    dt: '25/10/2026',
    ht: '17:59:00',
    and: 'p',
    carg: [
      {
        cd: '1',
        nmn: 'Presidente',
        agr: [
          {
            com: 'AAA/BBB',
            par: [
              {
                sg: 'AAA',
                cand: [{ n: '11', nm: 'CANDIDATA UM', nmu: 'UM', st: '', e: 'n', vap: '300', pvapn: '60,5' }],
              },
            ],
          },
          {
            com: 'CCC',
            par: [
              {
                sg: 'CCC',
                cand: [{ n: '22', nm: 'CANDIDATO DOIS', nmu: 'DOIS', st: '', e: 'n', vap: '200', pvapn: '39,5' }],
              },
            ],
          },
        ],
      },
    ],
    s: { ts: '40', st: '20', pstn: '50' },
    e: { te: '1000', c: '600', a: '400' },
    v: { vv: '500', vb: '40', tvn: '60' },
    ...overrides,
  };
}

export function rawTracking(entries: Array<{ code: string; and?: string; ht?: string; st?: string }>): RawTrackingFile {
  return {
    ele: '6258',
    idg: '1',
    abr: [
      { tpabr: 'uf', cdabr: 'AC', and: 'p', dt: '25/10/2026', ht: '18:00:00', s: { st: '0' } },
      ...entries.map((e) => ({
        tpabr: 'mun',
        cdabr: e.code,
        and: e.and ?? 'p',
        dt: '25/10/2026',
        ht: e.ht ?? '18:00:00',
        s: { st: e.st ?? '10' },
      })),
    ],
  };
}

