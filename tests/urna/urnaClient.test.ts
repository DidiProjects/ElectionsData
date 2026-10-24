import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, HttpResponse, JsonResponse } from '../../src/http/httpClient.js';
import { createUrnaClient, mapSectionList } from '../../src/urna/urnaClient.js';
import { buildBallotBoxReport, rawAux, rawCandidates, rawSectionList, section } from '../helpers.js';

const ref = { baseUrl: 'https://tse.example/oficial', cycle: 'ele2026', pleitoCode: 3221 };

function fakeHttp(json: JsonResponse, bytes: HttpResponse<Buffer> = { kind: 'not_found' }) {
  const getJson = vi.fn<HttpClient['getJson']>(async () => json);
  const getBytes = vi.fn<HttpClient['getBytes']>(async () => bytes);
  return { http: { getJson, getBytes }, getJson, getBytes };
}

const ok = (body: unknown, etag: string | null = null): JsonResponse => ({ kind: 'ok', body, etag });

describe('mapSectionList', () => {
  it('keeps principal sections, carries their aggregated sections and the publication stamp', () => {
    const sections = mapSectionList(
      rawSectionList([
        { ns: '0001', nsa: ['0002'], published: '25/10/2026 21:00:00' },
        { ns: '0002', nsp: '0001' },
        { ns: '0003' },
      ]),
    );
    expect(sections).toEqual([
      { state: 'ac', municipalityCode: '01066', municipalityName: 'CIDADE 01066', zone: '0004', section: '0001', aggregated: ['0002'], publishedAt: '25/10/2026 21:00:00' },
      { state: 'ac', municipalityCode: '01066', municipalityName: 'CIDADE 01066', zone: '0004', section: '0003', aggregated: [], publishedAt: null },
    ]);
  });
});

describe('createUrnaClient', () => {
  describe('getSectionList', () => {
    it('maps the list and returns the etag', async () => {
      const { http, getJson } = fakeHttp(ok(rawSectionList([{ ns: '0001' }]), '"e1"'));
      const response = await createUrnaClient(http, ref).getSectionList('ac', '"e0"');
      expect(response).toMatchObject({ kind: 'updated', etag: '"e1"', sections: [{ section: '0001' }] });
      expect(getJson).toHaveBeenCalledWith('https://tse.example/oficial/ele2026/arquivo-urna/3221/config/ac/ac-p003221-cs.json', {
        etag: '"e0"',
        signal: undefined,
      });
    });

    it.each([
      [{ kind: 'not_modified' } as const, 'not_modified'],
      [{ kind: 'not_found' } as const, 'not_found'],
      [ok({ nope: 1 }), 'invalid'],
      [ok(rawSectionList([], '3220')), 'invalid'],
    ])('maps %j to %s', async (json, kind) => {
      const { http } = fakeHttp(json);
      await expect(createUrnaClient(http, ref).getSectionList('ac', null)).resolves.toEqual({ kind });
    });
  });

  describe('getAux', () => {
    it('picks the latest totalized hash and its BU file', async () => {
      const { http, getJson } = fakeHttp(
        ok(rawAux([{ hash: 'old' }, { hash: 'replaced', st: 'Excluído' }, { hash: 'new', files: [{ nm: 'x.log', tp: 'log' }, { nm: 'new-bu.dat', tp: 'bu' }] }])),
      );
      await expect(createUrnaClient(http, ref).getAux(section())).resolves.toEqual({ kind: 'ready', hash: 'new', fileName: 'new-bu.dat' });
      expect(getJson.mock.calls[0]?.[0]).toBe(
        'https://tse.example/oficial/ele2026/arquivo-urna/3221/dados/ac/01066/0004/0077/p003221-ac-m01066-z0004-s0077-aux.json',
      );
    });

    it.each([
      [ok(rawAux([{ hash: 'h', st: 'Recebido' }])), 'pending'],
      [ok(rawAux([{ hash: 'h', files: [{ nm: 'x.log', tp: 'log' }] }])), 'pending'],
      [{ kind: 'not_found' } as const, 'not_found'],
      [{ kind: 'not_modified' } as const, 'invalid'],
      [ok({ st: 'x' }), 'invalid'],
    ])('maps %j to %s', async (json, kind) => {
      const { http } = fakeHttp(json);
      await expect(createUrnaClient(http, ref).getAux(section())).resolves.toEqual({ kind });
    });
  });

  describe('getReport', () => {
    const bu = (zone = 4) =>
      buildBallotBoxReport({ municipality: 1066, zone, section: 77, offices: [{ electionId: 6258, officeCode: 1, eligible: 1, turnout: 1, votes: [] }] });

    it('decodes the BU of the requested section', async () => {
      const { http, getBytes } = fakeHttp(ok({}), { kind: 'ok', body: bu(), etag: null });
      const response = await createUrnaClient(http, ref).getReport(section(), 'h1', 'f-bu.dat');
      expect(response).toMatchObject({ kind: 'ok', report: { municipality: 1066, zone: 4, section: 77 } });
      expect(getBytes.mock.calls[0]?.[0]).toBe('https://tse.example/oficial/ele2026/arquivo-urna/3221/dados/ac/01066/0004/0077/h1/f-bu.dat');
    });

    it('rejects a BU that belongs to another section', async () => {
      const { http } = fakeHttp(ok({}), { kind: 'ok', body: bu(5), etag: null });
      await expect(createUrnaClient(http, ref).getReport(section(), 'h', 'f')).resolves.toEqual({
        kind: 'invalid',
        reason: 'BU belongs to a different section',
      });
    });

    it('rejects an undecodable BU', async () => {
      const { http } = fakeHttp(ok({}), { kind: 'ok', body: Buffer.from([0x30, 0x05]), etag: null });
      await expect(createUrnaClient(http, ref).getReport(section(), 'h', 'f')).resolves.toMatchObject({ kind: 'invalid' });
    });

    it('passes not_found through and treats not_modified as invalid', async () => {
      await expect(createUrnaClient(fakeHttp(ok({})).http, ref).getReport(section(), 'h', 'f')).resolves.toEqual({ kind: 'not_found' });
      const { http } = fakeHttp(ok({}), { kind: 'not_modified' });
      await expect(createUrnaClient(http, ref).getReport(section(), 'h', 'f')).resolves.toMatchObject({ kind: 'invalid' });
    });

    it('rethrows unexpected decoding errors', async () => {
      const { http } = fakeHttp(ok({}));
      http.getBytes = vi.fn(async () => ({ kind: 'ok', body: null as unknown as Buffer, etag: null }));
      await expect(createUrnaClient(http, ref).getReport(section(), 'h', 'f')).rejects.toThrow(TypeError);
    });
  });

  describe('getCandidateNames', () => {
    it('maps candidate numbers to ballot names', async () => {
      const { http, getJson } = fakeHttp(ok(rawCandidates([{ n: '13', nmu: 'UM' }, { n: '22', nmu: 'DOIS' }])));
      await expect(createUrnaClient(http, ref).getCandidateNames(6258, 'al', 1)).resolves.toEqual(
        new Map([
          [13, 'UM'],
          [22, 'DOIS'],
        ]),
      );
      expect(getJson.mock.calls[0]?.[0]).toBe('https://tse.example/oficial/ele2026/6258/dados/al/al-c0001-e006258-u.json');
    });

    it('returns no names when the office has no file for that state', async () => {
      const { http } = fakeHttp({ kind: 'not_found' });
      await expect(createUrnaClient(http, ref).getCandidateNames(6260, 'sp', 3)).resolves.toEqual(new Map());
    });

    it('fails on an unusable file so the caller can retry', async () => {
      const { http } = fakeHttp(ok({ carg: 1 }));
      await expect(createUrnaClient(http, ref).getCandidateNames(6258, 'al', 1)).rejects.toThrow(/candidate file unusable/);
    });
  });
});
