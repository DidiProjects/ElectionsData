import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, JsonResponse } from '../../src/http/httpClient.js';
import { createTseClient } from '../../src/municipal/tseClient.js';
import { municipality, rawResult, rawTracking } from './helpers.js';

const ref = { baseUrl: 'https://tse.example/oficial', cycle: 'ele2026', electionCode: 6258 };

const httpReturning = (response: JsonResponse) => {
  const getJson = vi.fn<HttpClient['getJson']>(async () => response);
  return { http: { getJson, getBytes: vi.fn<HttpClient['getBytes']>() }, getJson };
};

describe('createTseClient', () => {
  describe('getMunicipalities', () => {
    it('maps and filters the municipality list', async () => {
      const { http, getJson } = httpReturning({
        kind: 'ok',
        etag: null,
        body: { dg: '', hg: '', abr: [{ cd: 'ac', ds: 'ACRE', mu: [{ cd: '01007', cdi: '1', nm: 'A' }] }, { cd: 'sp', ds: 'SP', mu: [] }] },
      });
      await expect(createTseClient(http, ref).getMunicipalities(['ac'])).resolves.toEqual([
        { state: 'ac', code: '01007', ibgeCode: '1', name: 'A' },
      ]);
      expect(getJson.mock.calls[0]?.[0]).toBe('https://tse.example/oficial/ele2026/6258/config/mun-e006258-cm.json');
    });

    it('fails when the list is not available', async () => {
      const { http } = httpReturning({ kind: 'not_found' });
      await expect(createTseClient(http, ref).getMunicipalities([])).rejects.toThrow(/unavailable \(not_found\)/);
    });

    it('fails when the list has an unexpected shape', async () => {
      const { http } = httpReturning({ kind: 'ok', etag: null, body: { abr: 1 } });
      await expect(createTseClient(http, ref).getMunicipalities([])).rejects.toThrow(/unexpected shape/);
    });
  });

  describe('getTracking', () => {
    it('builds a fingerprint per municipality, skipping the state aggregate', async () => {
      const { http, getJson } = httpReturning({
        kind: 'ok',
        etag: '"t1"',
        body: rawTracking([{ code: '01007', and: 'p', ht: '18:01:00', st: '12' }]),
      });
      const response = await createTseClient(http, ref).getTracking('ac', '"t0"');
      expect(response).toEqual({ kind: 'updated', etag: '"t1"', value: new Map([['01007', 'p|25/10/2026|18:01:00|12']]) });
      expect(getJson.mock.calls[0]).toEqual([
        'https://tse.example/oficial/ele2026/6258/dados/ac/ac-e006258-ab.json',
        { etag: '"t0"', signal: undefined },
      ]);
    });

    it.each([
      [{ kind: 'not_modified' } as const, 'not_modified'],
      [{ kind: 'not_found' } as const, 'not_found'],
      [{ kind: 'ok', etag: null, body: { nope: true } } as const, 'invalid'],
      [{ kind: 'ok', etag: null, body: { ...rawTracking([]), ele: '6257' } } as const, 'invalid'],
    ])('maps %j to %s', async (response, kind) => {
      const { http } = httpReturning(response);
      await expect(createTseClient(http, ref).getTracking('ac', null)).resolves.toEqual({ kind });
    });
  });

  describe('getMunicipalityResult', () => {
    it('returns the mapped result with its etag', async () => {
      const { http, getJson } = httpReturning({ kind: 'ok', etag: '"r1"', body: rawResult() });
      const response = await createTseClient(http, ref).getMunicipalityResult(municipality(), 1, '"r0"');
      expect(response).toMatchObject({ kind: 'updated', etag: '"r1"', value: { generationId: 100, officeCode: 1 } });
      expect(getJson.mock.calls[0]?.[0]).toBe('https://tse.example/oficial/ele2026/6258/dados/ac/ac01007-c0001-e006258-u.json');
      expect(getJson.mock.calls[0]?.[1]).toEqual({ etag: '"r0"', signal: undefined });
    });

    it.each([
      [{ kind: 'not_modified' } as const, 'not_modified'],
      [{ kind: 'not_found' } as const, 'not_found'],
      [{ kind: 'ok', etag: null, body: rawResult({ cdabr: '00000' }) } as const, 'invalid'],
    ])('maps %j to %s', async (response, kind) => {
      const { http } = httpReturning(response);
      await expect(createTseClient(http, ref).getMunicipalityResult(municipality(), 1, null)).resolves.toEqual({ kind });
    });
  });
});
