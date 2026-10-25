import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, JsonResponse } from '../../src/http/httpClient.js';
import { loadPleitoElections } from '../../src/municipal/electionCatalog.js';

const http = (response: JsonResponse): HttpClient => ({ getJson: vi.fn(async () => response), getBytes: vi.fn() });
const ref = { baseUrl: 'https://tse.example/oficial', pleitoCode: 3221, officeCodes: [1, 3] };

const catalog = {
  pl: [
    { cd: '3220', e: [{ cd: '6257', abr: [{ cd: 'br', cp: [{ cd: '1' }] }] }] },
    {
      cd: '3221',
      e: [
        { cd: '6284', abr: [{ cd: 'sp', cp: [{ cd: '11' }] }] },
        { cd: '6260', abr: [{ cd: 'ac', cp: [{ cd: '3' }] }, { cd: 'df', cp: [{ cd: '3' }] }] },
        { cd: '6258', abr: [{ cd: 'br', cp: [{ cd: '1' }] }] },
        'garbage',
        { cd: '6299', abr: ['x', { cp: 'y' }, { cp: ['z'] }] },
      ],
    },
  ],
};

describe('loadPleitoElections', () => {
  it('maps the configured offices to the elections of the pleito that carry them', async () => {
    const client = http({ kind: 'ok', etag: null, body: catalog });
    await expect(loadPleitoElections(client, ref)).resolves.toEqual([
      { electionCode: 6258, officeCodes: [1] },
      { electionCode: 6260, officeCodes: [3] },
    ]);
    expect(client.getJson).toHaveBeenCalledWith('https://tse.example/oficial/comum/config/ele-c.json', { signal: undefined });
  });

  it('includes supplementary elections when their office is configured', async () => {
    const elections = await loadPleitoElections(http({ kind: 'ok', etag: null, body: catalog }), { ...ref, officeCodes: [11] });
    expect(elections).toEqual([{ electionCode: 6284, officeCodes: [11] }]);
  });

  it('fails when the list is unavailable or the pleito is missing', async () => {
    await expect(loadPleitoElections(http({ kind: 'not_found' }), ref)).rejects.toThrow(/election list unavailable/);
    await expect(loadPleitoElections(http({ kind: 'ok', etag: null, body: [] }), ref)).rejects.toThrow(/election list unavailable/);
    await expect(loadPleitoElections(http({ kind: 'ok', etag: null, body: { pl: 'x' } }), ref)).rejects.toThrow(/pleito 3221 not found/);
  });
});
