import { describe, expect, it } from 'vitest';
import { municipalityConfigUrl, municipalityResultUrl, trackingUrl } from '../../src/municipal/urls.js';

const ref = { baseUrl: 'https://resultados.tse.jus.br/oficial', cycle: 'ele2026', electionCode: 6258 };

describe('TSE urls', () => {
  it('builds the municipality list url', () => {
    expect(municipalityConfigUrl(ref)).toBe(
      'https://resultados.tse.jus.br/oficial/ele2026/6258/config/mun-e006258-cm.json',
    );
  });

  it('builds the state tracking url with a lowercase UF', () => {
    expect(trackingUrl(ref, 'SP')).toBe('https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp-e006258-ab.json');
  });

  it('builds the municipality result url with padded office and election codes', () => {
    expect(municipalityResultUrl(ref, 'SP', '71072', 1)).toBe(
      'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp71072-c0001-e006258-u.json',
    );
  });
});
