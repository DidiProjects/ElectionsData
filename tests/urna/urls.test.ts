import { describe, expect, it } from 'vitest';
import { auxFileUrl, ballotBoxReportUrl, candidateFileUrl, sectionListUrl } from '../../src/urna/urls.js';

const ref = { baseUrl: 'https://resultados.tse.jus.br/oficial', cycle: 'ele2026', pleitoCode: 3221 };
const address = { state: 'ac', municipalityCode: '01066', zone: '0004', section: '0077' };
const DIR = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/dados/ac/01066/0004/0077';

describe('arquivo-urna urls', () => {
  it('builds the section list url with a lowercase UF', () => {
    expect(sectionListUrl(ref, 'SP')).toBe(
      'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/config/sp/sp-p003221-cs.json',
    );
  });

  it('builds the aux file url', () => {
    expect(auxFileUrl(ref, address)).toBe(`${DIR}/p003221-ac-m01066-z0004-s0077-aux.json`);
  });

  it('builds the BU url from hash and file name', () => {
    expect(ballotBoxReportUrl(ref, address, 'abc', 'o03221ac0106600040077-bu.dat')).toBe(
      `${DIR}/abc/o03221ac0106600040077-bu.dat`,
    );
  });

  it('builds the per-state candidate file url', () => {
    expect(candidateFileUrl(ref, 6258, 'AL', 1)).toBe(
      'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/al/al-c0001-e006258-u.json',
    );
  });
});
