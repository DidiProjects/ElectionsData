import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, USER_AGENT } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FetchFn } from '../src/http/httpClient.js';
import { silentLogger } from '../src/logger.js';
import {
  buildBallotBoxReport,
  bytesResponse,
  emptyResponse,
  FakeClock,
  jsonResponse,
  rawAux,
  rawCandidates,
  rawSectionList,
} from './helpers.js';

const BASE = 'https://tse.example/oficial/ele2026';
const ARCHIVE = `${BASE}/arquivo-urna/3221`;

describe('createApp', () => {
  let dir: string;
  let stateRoot: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-'));
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'app-state-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it('fetches each published BU once and writes a numbered version plus current per job', async () => {
    const clock = new FakeClock('2026-10-26T00:00:00Z');
    let listCalls = 0;
    const fetch = vi.fn<FetchFn>(async (url, init) => {
      const etag = (init.headers as Record<string, string>)['If-None-Match'];
      if (url === `${ARCHIVE}/config/ac/ac-p003221-cs.json`) {
        listCalls++;
        if (listCalls === 2 && etag) return emptyResponse(304);
        return jsonResponse(
          rawSectionList([
            { ns: '0001', nsa: ['0009'], published: '25/10/2026 21:00:00' },
            { ns: '0009', nsp: '0001' },
            { ns: '0002', ...(listCalls >= 3 ? { published: '25/10/2026 21:01:00' } : {}) },
          ]),
          { headers: { etag: `"l${listCalls}"` } },
        );
      }
      const aux = /\/dados\/ac\/01066\/0004\/(\d{4})\/p003221-ac-m01066-z0004-s\d{4}-aux\.json$/.exec(url);
      if (aux) return jsonResponse(rawAux([{ hash: `h${aux[1]}`, files: [{ nm: `s${aux[1]}-bu.dat`, tp: 'bu' }] }]));
      const bu = /\/dados\/ac\/01066\/0004\/(\d{4})\/h\d{4}\/s\d{4}-bu\.dat$/.exec(url);
      if (bu) {
        return bytesResponse(
          buildBallotBoxReport({
            municipality: 1066,
            zone: 4,
            section: Number(bu[1]),
            offices: [
              {
                electionId: 6258,
                officeCode: 1,
                eligible: 300,
                turnout: 200,
                votes: [
                  { type: 1, votes: 120, number: 13 },
                  { type: 1, votes: 70, number: 22 },
                  { type: 3, votes: 10 },
                ],
              },
            ],
          }),
        );
      }
      if (url === `${BASE}/6258/dados/ac/ac-c0001-e006258-u.json`) {
        return jsonResponse(rawCandidates([{ n: '13', nmu: 'CANDIDATO TREZE' }, { n: '22', nmu: 'CANDIDATO VINTE E DOIS' }]));
      }
      return emptyResponse(404);
    });

    const config = loadConfig({
      TSE_BASE_URL: 'https://tse.example/oficial',
      ELECTION_CYCLE: 'ele2026',
      PLEITO_CODE: '3221',
      OFFICE_CODES: '1',
      STATES: 'ac',
      OUTPUT_DIR: dir,
      STATE_DIR: path.join(stateRoot, 'state'),
      OUTPUT_PREFIX: 'secoes_2t2026',
      POLL_INTERVAL_SECONDS: '30',
      SCHEDULE_END: '2026-10-26T00:01:15Z',
    });
    await expect(createApp(config, { fetch, clock, logger: silentLogger }).run()).resolves.toBe('completed');

    const urls = fetch.mock.calls.map(([url]) => url);
    expect(listCalls).toBe(3);
    // Section 0001 in job 1, nothing in job 2 (304), section 0002 once published in job 3.
    expect(urls.filter((u) => u.endsWith('-bu.dat'))).toEqual([
      `${ARCHIVE}/dados/ac/01066/0004/0001/h0001/s0001-bu.dat`,
      `${ARCHIVE}/dados/ac/01066/0004/0002/h0002/s0002-bu.dat`,
    ]);
    expect(urls.filter((u) => u.endsWith('-u.json'))).toHaveLength(1);
    expect((fetch.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);

    expect((await fs.readdir(dir)).sort()).toEqual([
      'secoes_2t2026_0.csv',
      'secoes_2t2026_1.csv',
      'secoes_2t2026_2.csv',
      'secoes_2t2026_current.csv',
    ]);
    const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
    const rows = (csv: string) => csv.trimEnd().split('\n').slice(1);
    expect(rows(await read('secoes_2t2026_0.csv'))).toHaveLength(3);
    expect(rows(await read('secoes_2t2026_1.csv'))).toHaveLength(3);
    const latest = await read('secoes_2t2026_2.csv');
    expect(rows(latest)).toHaveLength(6);
    expect(await read('secoes_2t2026_current.csv')).toBe(latest);
    expect(rows(latest)[0]).toBe(
      '2026-10-25 21:01:00,AC,01066,CIDADE 01066,4,1,9,6258,1,Presidente,nominal,13,CANDIDATO TREZE,120,300,200,' +
        '2026-10-25 21:00:00,2026-10-25 08:00:00,2026-10-25 17:00:00,2026-10-25 17:02:00',
    );
  });

  it('restores downloaded BUs after a restart instead of fetching them again', async () => {
    const urls: string[] = [];
    const fetch = vi.fn<FetchFn>(async (url) => {
      urls.push(url);
      if (url.endsWith('-cs.json')) {
        return jsonResponse(rawSectionList([{ ns: '0001', published: '25/10/2026 21:00:00' }, { ns: '0002', published: '25/10/2026 21:00:00' }]));
      }
      const aux = /\/(\d{4})\/p003221-ac-m01066-z0004-s\d{4}-aux\.json$/.exec(url);
      if (aux) return jsonResponse(rawAux([{ hash: `h${aux[1]}`, files: [{ nm: `s${aux[1]}-bu.dat`, tp: 'bu' }] }]));
      const bu = /\/(\d{4})\/h\d{4}\/s\d{4}-bu\.dat$/.exec(url);
      if (bu) {
        return bytesResponse(
          buildBallotBoxReport({
            municipality: 1066,
            zone: 4,
            section: Number(bu[1]),
            offices: [{ electionId: 6258, officeCode: 1, eligible: 10, turnout: 9, votes: [{ type: 1, votes: 9, number: 13 }] }],
          }),
        );
      }
      if (url.endsWith('-u.json')) return jsonResponse(rawCandidates([{ n: '13', nmu: 'TREZE' }]));
      return emptyResponse(404);
    });
    const config = (end: string) =>
      loadConfig({
        TSE_BASE_URL: 'https://tse.example/oficial',
        ELECTION_CYCLE: 'ele2026',
        PLEITO_CODE: '3221',
        OFFICE_CODES: '1',
        STATES: 'ac',
        OUTPUT_DIR: dir,
        STATE_DIR: path.join(stateRoot, 'state'),
        OUTPUT_PREFIX: 'secoes_2t2026',
        POLL_INTERVAL_SECONDS: '30',
        SCHEDULE_END: end,
      });

    await createApp(config('2026-10-26T00:00:15Z'), { fetch, clock: new FakeClock('2026-10-26T00:00:00Z'), logger: silentLogger }).run();
    expect(urls.filter((u) => u.endsWith('-bu.dat'))).toHaveLength(2);

    urls.length = 0;
    await createApp(config('2026-10-26T00:10:15Z'), { fetch, clock: new FakeClock('2026-10-26T00:10:00Z'), logger: silentLogger }).run();
    expect(urls.filter((u) => u.endsWith('-bu.dat') || u.endsWith('-aux.json'))).toEqual([]);

    const current = await fs.readFile(path.join(dir, 'secoes_2t2026_current.csv'), 'utf8');
    expect(current.trimEnd().split('\n').slice(1)).toHaveLength(2);
    expect((await fs.readdir(dir)).sort()).toEqual(['secoes_2t2026_0.csv', 'secoes_2t2026_1.csv', 'secoes_2t2026_current.csv']);
  });
});
