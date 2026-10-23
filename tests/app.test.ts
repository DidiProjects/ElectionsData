import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, USER_AGENT } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FetchFn } from '../src/http/httpClient.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { emptyResponse, FakeClock, jsonResponse, rawResult, rawTracking } from './helpers.js';

const BASE = 'https://tse.example/oficial/ele2026/6258';
const PREFIX = 'ele2026_e006258_c0001';

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('exports only complete cycles, versioning in a folder with a fixed-name latest file', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    const logger: Logger = { ...silentLogger, warn: vi.fn() };
    let cycle = 0;
    let firstOutraCall = true;
    const fetch = vi.fn<FetchFn>(async (url, init) => {
      const etag = (init.headers as Record<string, string>)['If-None-Match'];
      if (url === `${BASE}/config/mun-e006258-cm.json`) {
        return jsonResponse({
          dg: '',
          hg: '',
          abr: [{ cd: 'ac', ds: 'ACRE', mu: [{ cd: '01007', cdi: '1200138', nm: 'CIDADE TESTE' }, { cd: '01008', cdi: '1', nm: 'OUTRA' }] }],
        });
      }
      if (url === `${BASE}/dados/ac/ac-e006258-ab.json`) {
        cycle++;
        if (cycle === 2 && etag) return emptyResponse(304);
        const ht = cycle >= 3 ? '18:05:00' : '18:00:00';
        return jsonResponse(rawTracking([{ code: '01007', ht }, { code: '01008' }]), { headers: { etag: `"ab${cycle}"` } });
      }
      const match = /\/dados\/ac\/ac(\d{5})-c0001-e006258-u\.json$/.exec(url);
      if (match) {
        if (match[1] === '01008' && firstOutraCall) {
          firstOutraCall = false;
          return jsonResponse({ broken: true });
        }
        return jsonResponse(rawResult({ cdabr: match[1], idg: String(100 + cycle), ht: `18:0${cycle}:00` }), {
          headers: { etag: `"r${cycle}"` },
        });
      }
      return emptyResponse(404);
    });

    const config = loadConfig({
      TSE_BASE_URL: 'https://tse.example/oficial',
      ELECTION_CYCLE: 'ele2026',
      ELECTION_CODE: '6258',
      OFFICE_CODES: '1',
      OUTPUT_DIR: dir,
      POLL_INTERVAL_SECONDS: '30',
      SCHEDULE_END: '2026-10-25T20:01:15Z',
    });
    await expect(createApp(config, { fetch, clock, logger }).run()).resolves.toBe('completed');

    // Cycle 1 leaves 01008 without a valid value: nothing may be published.
    expect(logger.warn).toHaveBeenCalledWith(
      'cycle left gaps, export skipped until every municipality has a value',
      { missing: 1 },
    );
    // Cycle 2 (tracking 304) retries only 01008; cycle 3 only the municipality that moved.
    const resultCalls = fetch.mock.calls.map(([url]) => url).filter((u) => u.endsWith('-u.json'));
    expect(resultCalls).toEqual([
      `${BASE}/dados/ac/ac01007-c0001-e006258-u.json`,
      `${BASE}/dados/ac/ac01008-c0001-e006258-u.json`,
      `${BASE}/dados/ac/ac01008-c0001-e006258-u.json`,
      `${BASE}/dados/ac/ac01007-c0001-e006258-u.json`,
    ]);
    expect((fetch.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);

    expect((await fs.readdir(dir)).sort()).toEqual([PREFIX, `${PREFIX}.csv`]);
    const versions = (await fs.readdir(path.join(dir, PREFIX))).sort();
    expect(versions).toEqual(['20261025T200030000Z.csv', '20261025T200100000Z.csv']);

    const first = await fs.readFile(path.join(dir, PREFIX, versions[0] as string), 'utf8');
    const newest = await fs.readFile(path.join(dir, PREFIX, versions[1] as string), 'utf8');
    const latest = await fs.readFile(path.join(dir, `${PREFIX}.csv`), 'utf8');
    for (const csv of [first, newest]) {
      expect(new Set(csv.trimEnd().split('\n').slice(1).map((l) => l.split(',')[5]))).toEqual(new Set(['01007', '01008']));
    }
    expect(latest).toBe(newest);
    expect(newest).toContain(',18:03:00,');
  });
});
