import type { Clock } from '../src/clock.js';
import type { Section, SectionResult } from '../src/domain/types.js';
import type { CandidateSink, SectionRepository } from '../src/results/sectionRepository.js';
import type { RawSectionList } from '../src/urna/rawTypes.js';

/** In-memory stand-in for the Postgres repository; survives across app instances like a database. */
export function memoryRepository(): SectionRepository & CandidateSink & { sections: Map<string, SectionResult> } {
  const sections = new Map<string, SectionResult>();
  const key = (r: SectionResult) => `${r.section.state}-${r.section.municipalityCode}-${r.section.zone}-${r.section.section}`;
  return {
    sections,
    loadAll: async () => [...sections.values()].map((r) => structuredClone(r)),
    save: async (results) => {
      for (const r of results) sections.set(key(r), structuredClone(r));
    },
    saveCandidates: async () => undefined,
  };
}

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

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export const bytesResponse = (body: Buffer, headers: Record<string, string> = {}): Response =>
  new Response(new Uint8Array(body), { status: 200, headers });

export const emptyResponse = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });

// ── Minimal DER encoder, enough to build synthetic ballot box reports ──────────

const encodeLength = (length: number): Buffer => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let l = length; l > 0; l = Math.floor(l / 256)) bytes.unshift(l % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const tlv = (identifier: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([identifier]), encodeLength(content.length), content]);

const intBytes = (value: number): Buffer => {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
};

export const der = {
  int: (v: number) => tlv(0x02, intBytes(v)),
  enumerated: (v: number) => tlv(0x0a, intBytes(v)),
  str: (s: string) => tlv(0x1b, Buffer.from(s, 'latin1')),
  octets: (b: Buffer) => tlv(0x04, b),
  seq: (...items: Buffer[]) => tlv(0x30, Buffer.concat(items)),
  /** Context-specific primitive [n] holding an unsigned integer. */
  ctxInt: (n: number, v: number) => tlv(0x80 | n, intBytes(v)),
  /** Context-specific constructed [n]. */
  ctx: (n: number, ...items: Buffer[]) => tlv(0xa0 | n, Buffer.concat(items)),
};

export interface FakeVote {
  type: number;
  votes?: number;
  party?: number;
  number?: number;
}

export interface FakeOffice {
  electionId: number;
  officeCode: number;
  eligible: number;
  turnout: number;
  votes: FakeVote[];
}

const SIGNATURE = Buffer.alloc(8, 0xab);

const encodeVote = (v: FakeVote, order: number): Buffer =>
  der.seq(
    der.ctxInt(1, v.type),
    ...(v.votes === undefined ? [] : [der.ctxInt(2, v.votes)]),
    ...(v.number === undefined ? [] : [der.ctx(3, der.int(v.party ?? v.number), der.int(v.number))]),
    der.int(order),
    der.octets(SIGNATURE),
  );

/** Same layout as a real 2026 BU: envelope -> OCTET STRING -> report. */
export function buildBallotBoxReport(opts: {
  municipality: number;
  zone: number;
  section: number;
  offices: FakeOffice[];
  emittedAt?: string;
  openedAt?: string;
  closedAt?: string;
}): Buffer {
  const header = der.seq(der.str('20261025T170500'), der.ctxInt(2, 3220));
  const identity = der.seq(der.seq(der.int(opts.municipality), der.int(opts.zone)), der.int(1031), der.int(opts.section));
  const byElection = new Map<number, FakeOffice[]>();
  for (const o of opts.offices) byElection.set(o.electionId, [...(byElection.get(o.electionId) ?? []), o]);

  const elections = [...byElection].map(([electionId, offices]) =>
    der.seq(
      der.int(electionId),
      der.int(offices[0]?.eligible ?? 0),
      der.int(offices[0]?.eligible ?? 0),
      der.int(0),
      der.seq(
        ...offices.map((o) =>
          der.seq(
            der.enumerated(1),
            der.int(o.turnout),
            der.seq(der.seq(der.ctxInt(1, o.officeCode), der.int(1), der.seq(...o.votes.map(encodeVote)))),
          ),
        ),
      ),
      der.octets(SIGNATURE),
    ),
  );

  const report = der.seq(
    header,
    der.enumerated(2),
    der.seq(der.enumerated(1), der.str('10.0.0.0 - Test')),
    identity,
    der.str(opts.emittedAt ?? '20261025T170200'),
    der.ctx(0, der.str(opts.openedAt ?? '20261025T080000'), der.str(opts.closedAt ?? '20261025T170000')),
    der.int(100),
    der.seq(...elections),
    der.seq(der.str('0000')),
  );
  return der.seq(header, der.enumerated(2), der.ctx(0, identity), der.enumerated(1), der.octets(report));
}

export const section = (overrides: Partial<Section> = {}): Section => ({
  state: 'ac',
  municipalityCode: '01066',
  municipalityName: 'CIDADE TESTE',
  zone: '0004',
  section: '0077',
  aggregated: [],
  publishedAt: '25/10/2026 21:00:00',
  ...overrides,
});

export function rawSectionList(
  entries: Array<{ mun?: string; zone?: string; ns: string; nsa?: string[]; nsp?: string; published?: string }>,
  pleito = '3221',
): RawSectionList {
  const byMun = new Map<string, Map<string, RawSectionList['abr'][number]['mu'][number]['zon'][number]['sec']>>();
  for (const e of entries) {
    const zones = byMun.get(e.mun ?? '01066') ?? new Map();
    const secs = zones.get(e.zone ?? '0004') ?? [];
    const [da, ha] = e.published?.split(' ') ?? [];
    secs.push({
      ns: e.ns,
      ...(e.nsa ? { nsa: e.nsa } : {}),
      ...(e.nsp ? { nsp: e.nsp } : {}),
      ...(da && ha ? { da, ha } : {}),
    });
    zones.set(e.zone ?? '0004', secs);
    byMun.set(e.mun ?? '01066', zones);
  }
  return {
    cdp: pleito,
    abr: [
      {
        cd: 'ac',
        mu: [...byMun].map(([cd, zones]) => ({
          cd,
          nm: `CIDADE ${cd}`,
          zon: [...zones].map(([zcd, sec]) => ({ cd: zcd, sec })),
        })),
      },
    ],
  };
}

export const rawAux = (hashes: Array<{ hash: string; st?: string; files?: Array<{ nm: string; tp: string }> }>) => ({
  dg: '25/10/2026',
  hg: '21:00:00',
  idg: '1',
  f: 'o',
  st: 'Totalizada',
  hashes: hashes.map((h) => ({
    hash: h.hash,
    dr: '25/10/2026',
    hr: '17:30:00',
    st: h.st ?? 'Totalizado',
    arq: h.files ?? [{ nm: 'o03221ac0106600040077-bu.dat', tp: 'bu' }],
  })),
});

export const rawCandidates = (candidates: Array<{ n: string; nmu: string }>) => ({
  carg: [{ agr: [{ par: [{ cand: candidates }, {}] }] }],
});
