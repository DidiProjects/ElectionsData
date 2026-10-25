import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVersionedCsvWriter } from '../../src/export/versionedCsvWriter.js';
import { createCooldownGate } from '../../src/http/cooldownGate.js';
import { createHttpClient, type FetchFn } from '../../src/http/httpClient.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import { createMunicipalCollector } from '../../src/municipal/collector.js';
import { emptyResponse, FakeClock, jsonResponse, rawResult, rawTracking } from './helpers.js';

const BASE = 'https://tse.example/oficial';

const catalog = {
  pl: [
    {
      cd: '3221',
      e: [
        { cd: '6258', abr: [{ cd: 'br', cp: [{ cd: '1' }] }] },
        { cd: '6260', abr: [{ cd: 'ac', cp: [{ cd: '3' }] }] },
      ],
    },
  ],
};

const municipalities = (election: string) => ({
  dg: '',
  hg: '',
  abr: [{ cd: 'ac', ds: 'ACRE', mu: [{ cd: '01007', cdi: '1200138', nm: `CIDADE ${election}` }] }],
});

function fakeTse(overrides: { catalogDown?: boolean; brokenGovernor?: boolean } = {}) {
  let catalogCalls = 0;
  const fetch = vi.fn<FetchFn>(async (url) => {
    if (url === `${BASE}/comum/config/ele-c.json`) {
      catalogCalls++;
      return overrides.catalogDown && catalogCalls === 1 ? emptyResponse(404) : jsonResponse(catalog);
    }
    const cm = /\/ele2026\/(\d{4})\/config\/mun-e00\d{4}-cm\.json$/.exec(url);
    if (cm) return jsonResponse(municipalities(cm[1] as string));
    const ab = /\/ele2026\/(\d{4})\/dados\/ac\/ac-e00\d{4}-ab\.json$/.exec(url);
    if (ab) return jsonResponse({ ...rawTracking([{ code: '01007' }]), ele: ab[1] });
    const u = /\/ele2026\/(\d{4})\/dados\/ac\/ac01007-c(\d{4})-e00\d{4}-u\.json$/.exec(url);
    if (u) {
      if (overrides.brokenGovernor && u[1] === '6260') return jsonResponse({ broken: true });
      const office = String(Number(u[2]));
      return jsonResponse(rawResult({ ele: u[1], carg: [{ ...rawResult().carg[0]!, cd: office, nmn: office === '1' ? 'Presidente' : 'Governador' }] }));
    }
    return emptyResponse(404);
  });
  return fetch;
}

describe('createMunicipalCollector', () => {
  let dir: string;
  let logger: Logger;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'municipal-'));
    logger = { ...silentLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const build = (fetch: FetchFn, writerDir = dir) => {
    const clock = new FakeClock();
    const http = createHttpClient({
      fetch,
      clock,
      gate: createCooldownGate(clock),
      logger: silentLogger,
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      timeoutMs: 1000,
      userAgent: 'test',
    });
    return createMunicipalCollector({
      http,
      logger,
      writer: createVersionedCsvWriter({ outputDir: writerDir, prefix: 'municipios_2t2026', maxVersions: 1000 }),
      baseUrl: BASE,
      cycle: 'ele2026',
      pleitoCode: 3221,
      officeCodes: [1, 3],
      states: ['ac'],
      concurrency: 4,
    });
  };

  const rows = async (name: string) => (await fs.readFile(path.join(dir, name), 'utf8')).trimEnd().split('\n').slice(1);

  it('polls every election of the pleito and writes one CSV with all configured offices', async () => {
    const stats = await build(fakeTse()).runJob(new AbortController().signal);
    expect(stats.complete).toBe(true);
    expect(stats.elections.map((e) => [e.electionCode, e.updated])).toEqual([
      [6258, 1],
      [6260, 1],
    ]);
    expect((await fs.readdir(dir)).sort()).toEqual(['municipios_2t2026_0.csv', 'municipios_2t2026_current.csv']);
    const offices = (await rows('municipios_2t2026_current.csv')).map((l) => l.split(',').slice(0, 4).join(','));
    expect(new Set(offices)).toEqual(new Set(['6258,2,1,Presidente', '6260,2,3,Governador']));
  });

  it('writes a new version every complete job', async () => {
    const collector = build(fakeTse());
    await collector.runJob();
    await collector.runJob();
    expect((await fs.readdir(dir)).sort()).toEqual([
      'municipios_2t2026_0.csv',
      'municipios_2t2026_1.csv',
      'municipios_2t2026_current.csv',
    ]);
  });

  it('publishes nothing while any election has gaps', async () => {
    const stats = await build(fakeTse({ brokenGovernor: true })).runJob();
    expect(stats.complete).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('municipal job left gaps, export skipped', { missing: 1 });
  });

  it('retries the election list on the next job when it is unavailable', async () => {
    const collector = build(fakeTse({ catalogDown: true }));
    expect(await collector.runJob()).toEqual({ elections: [], complete: false });
    expect(logger.error).toHaveBeenCalledWith('election list unavailable, will retry next job', expect.any(Object));
    expect((await collector.runJob()).complete).toBe(true);
  });

  it('does not publish when no configured office is voted in the pleito', async () => {
    const fetch = vi.fn<FetchFn>(async () => jsonResponse({ pl: [{ cd: '3221', e: [] }] }));
    expect(await build(fetch).runJob()).toEqual({ elections: [], complete: false });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('logs a failed export and tries again next job', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    await fs.writeFile(blocker, 'x');
    await build(fakeTse(), blocker).runJob();
    expect(logger.error).toHaveBeenCalledWith('municipal csv export failed, will retry next job', expect.any(Object));
  });
});
