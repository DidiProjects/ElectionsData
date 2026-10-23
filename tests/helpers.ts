import type { Clock } from '../src/clock.js';
import type { Municipality } from '../src/domain/types.js';
import type { RawMunicipalityResult, RawTrackingFile } from '../src/tse/rawTypes.js';

interface PendingSleep {
  at: number;
  resolve: () => void;
}

/**
 * Virtual time: once the event loop is idle, the clock jumps straight to the earliest
 * pending sleep and wakes it, so concurrent schedules interleave as they would in real time.
 */
export class FakeClock implements Clock {
  private current: number;
  private pending: PendingSleep[] = [];
  private flushScheduled = false;
  readonly sleeps: number[] = [];

  constructor(start: string | Date = '2026-10-25T17:00:00Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry: PendingSleep = { at: this.current + Math.max(0, ms), resolve };
      this.pending.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.pending = this.pending.filter((p) => p !== entry);
          resolve();
        },
        { once: true },
      );
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.pending.length === 0) return;
      this.pending.sort((a, b) => a.at - b.at);
      const next = this.pending.shift() as PendingSleep;
      this.current = Math.max(this.current, next.at);
      next.resolve();
      if (this.pending.length > 0) this.scheduleFlush();
    });
  }
}

export const municipality = (overrides: Partial<Municipality> = {}): Municipality => ({
  state: 'ac',
  code: '01007',
  ibgeCode: '1200138',
  name: 'CIDADE TESTE',
  ...overrides,
});

export function rawResult(overrides: Partial<RawMunicipalityResult> = {}): RawMunicipalityResult {
  return {
    ele: '6258',
    t: '2',
    tpabr: 'mu',
    cdabr: '01007',
    dg: '25/10/2026',
    hg: '18:00:00',
    idg: '100',
    dt: '25/10/2026',
    ht: '17:59:00',
    and: 'p',
    carg: [
      {
        cd: '1',
        nmn: 'Presidente',
        agr: [
          {
            com: 'AAA/BBB',
            par: [
              {
                sg: 'AAA',
                cand: [{ n: '11', nm: 'CANDIDATA UM', nmu: 'UM', st: '', e: 'n', vap: '300', pvapn: '60,5' }],
              },
            ],
          },
          {
            com: 'CCC',
            par: [
              {
                sg: 'CCC',
                cand: [{ n: '22', nm: 'CANDIDATO DOIS', nmu: 'DOIS', st: '', e: 'n', vap: '200', pvapn: '39,5' }],
              },
            ],
          },
        ],
      },
    ],
    s: { ts: '40', st: '20', pstn: '50' },
    e: { te: '1000', c: '600', a: '400' },
    v: { vv: '500', vb: '40', tvn: '60' },
    ...overrides,
  };
}

export function rawTracking(entries: Array<{ code: string; and?: string; ht?: string; st?: string }>): RawTrackingFile {
  return {
    ele: '6258',
    idg: '1',
    abr: [
      { tpabr: 'uf', cdabr: 'AC', and: 'p', dt: '25/10/2026', ht: '18:00:00', s: { st: '0' } },
      ...entries.map((e) => ({
        tpabr: 'mun',
        cdabr: e.code,
        and: e.and ?? 'p',
        dt: '25/10/2026',
        ht: e.ht ?? '18:00:00',
        s: { st: e.st ?? '10' },
      })),
    ],
  };
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export const emptyResponse = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });
