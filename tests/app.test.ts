import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, USER_AGENT } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FetchFn } from '../src/http/httpClient.js';
import { silentLogger } from '../src/logger.js';
import { emptyResponse, FakeClock, jsonResponse, rawResult, rawTracking } from './helpers.js';

const BASE = 'https://tse.example/oficial/ele2026/6258';

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('polls only changed municipalities and writes versioned CSVs within the window', async () => {
    const clock = new FakeClock('2026-10-25T20:00:00Z');
    let trackingCalls = 0;
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
        trackingCalls++;
        if (trackingCalls === 2 && etag) return emptyResponse(304);
        const ht = trackingCalls >= 3 ? '18:05:00' : '18:00:00';
        return jsonResponse(rawTracking([{ code: '01007', ht }, { code: '01008' }]), { headers: { etag: `"ab${trackingCalls}"` } });
      }
      const match = /\/dados\/ac\/ac(\d{5})-c0001-e006258-u\.json$/.exec(url);
      if (match) {
        const idg = String(100 + trackingCalls);
        const ht = `18:0${trackingCalls}:00`;
        return jsonResponse(rawResult({ cdabr: match[1], idg, ht }), { headers: { etag: `"r${idg}"` } });
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
      EXPORT_INTERVAL_SECONDS: '60',
      SCHEDULE_END: '2026-10-25T20:01:45Z',
    });
    const outcome = await createApp(config, { fetch, clock, logger: silentLogger }).run();
    expect(outcome).toBe('completed');

    const resultCalls = fetch.mock.calls.map(([url]) => url).filter((u) => u.endsWith('-u.json'));
    // Cycle 1: both municipalities. Cycle 2: 304. Cycles 3 and 4: only the one whose fingerprint moved.
    expect(trackingCalls).toBe(4);
    expect(resultCalls).toEqual([
      `${BASE}/dados/ac/ac01007-c0001-e006258-u.json`,
      `${BASE}/dados/ac/ac01008-c0001-e006258-u.json`,
      `${BASE}/dados/ac/ac01007-c0001-e006258-u.json`,
    ]);
    expect((fetch.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);

    // Real fs I/O interleaves with virtual time, so how many scheduled exports land varies;
    // the invariant is that the final export leaves the newest valid state on disk.
    const files = (await fs.readdir(dir)).sort();
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) expect(file).toMatch(/^ele2026_e006258_c0001_20261025T\d{9}Z\.csv$/);
    const latest = await fs.readFile(path.join(dir, files.at(-1) as string), 'utf8');
    expect(latest.trimEnd().split('\n')).toHaveLength(5);
    expect(latest).toContain(',18:03:00,');
  });
});
