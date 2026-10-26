import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, fileName, USER_AGENT, type AppDependencies } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrator.js';
import type { FetchFn } from '../src/http/httpClient.js';
import { silentLogger } from '../src/logger.js';
import { createPostgresSectionRepository } from '../src/results/postgresSectionRepository.js';
import { createTestDatabase, describeDb, MIGRATIONS_DIR } from './db/testDatabase.js';
import {
  buildBallotBoxReport,
  bytesResponse,
  emptyResponse,
  FakeClock,
  jsonResponse,
  memoryRepository,
  rawAux,
  rawCandidates,
  rawSectionList,
} from './helpers.js';

const BASE = 'https://tse.example/oficial/ele2026';
const ARCHIVE = `${BASE}/arquivo-urna/3221`;

/** Fake TSE: section 0001 (with 0009 aggregated) is published; 0002 only from the 3rd list on. */
function fakeTse() {
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
  return { fetch, listCalls: () => listCalls };
}

describe('fileName', () => {
  it('appends the tag when there is one', () => {
    expect(fileName('secoes', '2t2026')).toBe('secoes_2t2026');
    expect(fileName('municipios', '')).toBe('municipios');
  });
});

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const config = (end: string) =>
    loadConfig({
      TSE_BASE_URL: 'https://tse.example/oficial',
      ELECTION_CYCLE: 'ele2026',
      PLEITO_CODE: '3221',
      OFFICE_CODES: '1',
      STATES: 'ac',
      COLLECTORS: 'secoes,municipios',
      OUTPUT_DIR: dir,
      DATABASE_URL: 'postgresql://unused-in-unit-tests',
      OUTPUT_TAG: '2t2026',
      POLL_INTERVAL_SECONDS: '30',
      SCHEDULE_END: end,
    });
  const read = (name: string) => fs.readFile(path.join(dir, 'secoes', name), 'utf8');
  const rows = (csv: string) => csv.trimEnd().split('\n').slice(1);
  const buUrls = (fetch: ReturnType<typeof fakeTse>['fetch']) =>
    fetch.mock.calls.map(([url]) => url).filter((u) => u.endsWith('-bu.dat') || u.endsWith('-aux.json'));

  it('fetches each published BU once and writes a numbered version plus current per job', async () => {
    const tse = fakeTse();
    const repository = memoryRepository();
    const deps: AppDependencies = { fetch: tse.fetch, clock: new FakeClock('2026-10-26T00:00:00Z'), logger: silentLogger, repository };
    await expect(createApp(config('2026-10-26T00:01:15Z'), deps).run()).resolves.toBe('completed');

    expect(tse.listCalls()).toBe(3);
    // Section 0001 in job 1, nothing in job 2 (304), section 0002 once published in job 3.
    expect(tse.fetch.mock.calls.map(([url]) => url).filter((u) => u.endsWith('-bu.dat'))).toEqual([
      `${ARCHIVE}/dados/ac/01066/0004/0001/h0001/s0001-bu.dat`,
      `${ARCHIVE}/dados/ac/01066/0004/0002/h0002/s0002-bu.dat`,
    ]);
    expect(tse.fetch.mock.calls.map(([url]) => url).filter((u) => u.endsWith('-u.json'))).toHaveLength(1);
    expect((tse.fetch.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect([...repository.sections.keys()].sort()).toEqual(['ac-01066-0004-0001', 'ac-01066-0004-0002']);

    expect((await fs.readdir(path.join(dir, 'secoes'))).sort()).toEqual([
      'secoes_2t2026_0.csv',
      'secoes_2t2026_1.csv',
      'secoes_2t2026_2.csv',
      'secoes_2t2026_current.csv',
    ]);
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

  it('runs only the municipality collector by default', async () => {
    const tse = fakeTse();
    const defaults = loadConfig({
      TSE_BASE_URL: 'https://tse.example/oficial',
      ELECTION_CYCLE: 'ele2026',
      PLEITO_CODE: '3221',
      OFFICE_CODES: '1',
      STATES: 'ac',
      OUTPUT_DIR: dir,
      DATABASE_URL: 'postgresql://unused-in-unit-tests',
      POLL_INTERVAL_SECONDS: '30',
      SCHEDULE_END: '2026-10-26T00:00:45Z',
    });
    const deps: AppDependencies = {
      fetch: tse.fetch,
      clock: new FakeClock('2026-10-26T00:00:00Z'),
      logger: silentLogger,
      repository: memoryRepository(),
    };
    await createApp(defaults, deps).run();
    const urls = tse.fetch.mock.calls.map(([url]) => url);
    expect(urls.some((u) => u.includes('/arquivo-urna/'))).toBe(false);
    expect(urls).toContain('https://tse.example/oficial/comum/config/ele-c.json');
  });

  it('restores downloaded BUs after a restart instead of fetching them again', async () => {
    const repository = memoryRepository();
    const first = fakeTse();
    await createApp(config('2026-10-26T00:00:15Z'), {
      fetch: first.fetch,
      clock: new FakeClock('2026-10-26T00:00:00Z'),
      logger: silentLogger,
      repository,
    }).run();
    expect(buUrls(first.fetch)).toHaveLength(2);

    const second = fakeTse();
    await createApp(config('2026-10-26T00:10:15Z'), {
      fetch: second.fetch,
      clock: new FakeClock('2026-10-26T00:10:00Z'),
      logger: silentLogger,
      repository,
    }).run();
    expect(buUrls(second.fetch)).toEqual([]);
    expect(rows(await read('secoes_2t2026_current.csv'))).toHaveLength(3);
    expect((await fs.readdir(path.join(dir, 'secoes'))).sort()).toEqual(['secoes_2t2026_0.csv', 'secoes_2t2026_1.csv', 'secoes_2t2026_current.csv']);
  });

  describe('backfill', () => {
    const backfillConfig = (extra: Record<string, string> = {}) =>
      loadConfig({
        TSE_BASE_URL: 'https://tse.example/oficial',
        ELECTION_CYCLE: 'ele2026',
        PLEITO_CODE: '3221',
        OFFICE_CODES: '1',
        STATES: 'ac',
        COLLECTORS: 'secoes,municipios',
        OUTPUT_DIR: dir,
        DATABASE_URL: 'postgresql://unused-in-unit-tests',
        OUTPUT_TAG: '2t2026',
        POLL_INTERVAL_SECONDS: '30',
        CONCURRENCY: '1',
        MODE: 'backfill',
        // A closed window must not matter: backfill ignores the schedule.
        SCHEDULE_END: '2026-10-01T00:00:00Z',
        ...extra,
      });

    /** Four published sections; each BU download costs 20s of virtual time. */
    function slowTse(clock: FakeClock) {
      const sections = ['0001', '0002', '0003', '0004'];
      return vi.fn<FetchFn>(async (url) => {
        if (url.endsWith('-cs.json')) return jsonResponse(rawSectionList(sections.map((ns) => ({ ns, published: '25/10/2026 21:00:00' }))));
        const aux = /\/(\d{4})\/p003221-ac-m01066-z0004-s\d{4}-aux\.json$/.exec(url);
        if (aux) return jsonResponse(rawAux([{ hash: `h${aux[1]}`, files: [{ nm: `s${aux[1]}-bu.dat`, tp: 'bu' }] }]));
        const bu = /\/(\d{4})\/h\d{4}\/s\d{4}-bu\.dat$/.exec(url);
        if (bu) {
          clock.advance(20_000);
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
    }

    it('runs passes back to back until nothing is deferred, stores everything and writes one CSV', async () => {
      const clock = new FakeClock('2026-10-26T00:00:00Z');
      const repository = memoryRepository();
      const fetch = slowTse(clock);
      const summary = await createApp(backfillConfig(), { fetch, clock, logger: silentLogger, repository }).backfill();
      expect(summary).toEqual({ passes: 2, restored: 0, fetched: 4, pending: 0, invalid: 0, failed: 0, stored: 4, aborted: false });
      expect(repository.sections.size).toBe(4);
      expect((await fs.readdir(path.join(dir, 'secoes'))).sort()).toEqual(['secoes_2t2026_0.csv', 'secoes_2t2026_current.csv']);
      expect(rows(await read('secoes_2t2026_current.csv'))).toHaveLength(4);
      // No waiting between passes: only the BU downloads moved the clock.
      expect(clock.now().toISOString()).toBe('2026-10-26T00:01:20.000Z');
    });

    it('lets the scheduled job start from what the backfill loaded', async () => {
      const repository = memoryRepository();
      const backfillClock = new FakeClock('2026-10-26T00:00:00Z');
      await createApp(backfillConfig(), { fetch: slowTse(backfillClock), clock: backfillClock, logger: silentLogger, repository }).backfill();

      const jobClock = new FakeClock('2026-10-26T01:00:00Z');
      const fetch = slowTse(jobClock);
      await createApp(backfillConfig({ MODE: 'job', SCHEDULE_END: '2026-10-26T01:00:15Z' }), {
        fetch,
        clock: jobClock,
        logger: silentLogger,
        repository,
      }).run();
      expect(buUrls(fetch)).toEqual([]);
      expect(rows(await read('secoes_2t2026_current.csv'))).toHaveLength(4);
    });

    it('stops at the end of the current pass when aborted', async () => {
      const clock = new FakeClock('2026-10-26T00:00:00Z');
      const controller = new AbortController();
      const inner = slowTse(clock);
      const fetch = vi.fn<FetchFn>(async (url, init) => {
        const response = await inner(url, init);
        if (url.endsWith('-bu.dat')) controller.abort();
        return response;
      });
      const summary = await createApp(backfillConfig(), { fetch, clock, logger: silentLogger, repository: memoryRepository() }).backfill(
        controller.signal,
      );
      expect(summary).toMatchObject({ passes: 1, fetched: 1, aborted: true });
    });
  });

  describeDb('against Postgres', () => {
    it('survives a restart through the database and serves the view', async () => {
      const t = await createTestDatabase();
      try {
        await runMigrations(t.db, MIGRATIONS_DIR, silentLogger);
        const repository = createPostgresSectionRepository(t.db, 3221);
        const first = fakeTse();
        await createApp(config('2026-10-26T00:00:15Z'), {
          fetch: first.fetch,
          clock: new FakeClock('2026-10-26T00:00:00Z'),
          logger: silentLogger,
          repository,
        }).run();

        const second = fakeTse();
        await createApp(config('2026-10-26T00:10:15Z'), {
          fetch: second.fetch,
          clock: new FakeClock('2026-10-26T00:10:00Z'),
          logger: silentLogger,
          repository: createPostgresSectionRepository(t.db, 3221),
        }).run();
        expect(buUrls(second.fetch)).toEqual([]);

        const view = await t.db.query<{ nm_votavel: string | null; qt_votos: number }>(
          'SELECT nm_votavel, qt_votos FROM votos_secao ORDER BY ordem',
        );
        expect(view).toEqual([
          { nm_votavel: 'CANDIDATO TREZE', qt_votos: 120 },
          { nm_votavel: 'CANDIDATO VINTE E DOIS', qt_votos: 70 },
          { nm_votavel: null, qt_votos: 10 },
        ]);
        expect(rows(await read('secoes_2t2026_current.csv'))).toHaveLength(3);
      } finally {
        await t.drop();
      }
    });
  });
});
