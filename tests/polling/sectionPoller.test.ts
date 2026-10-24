import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Section } from '../../src/domain/types.js';
import { silentLogger } from '../../src/logger.js';
import { createSectionPoller } from '../../src/polling/sectionPoller.js';
import type { SectionRepository } from '../../src/results/sectionRepository.js';
import { createSectionStore, type SectionStore } from '../../src/results/sectionStore.js';
import type { BallotBoxReport } from '../../src/urna/bu.js';
import type { UrnaClient } from '../../src/urna/urnaClient.js';
import { FakeClock, section } from '../helpers.js';

const A = section({ section: '0001' });
const B = section({ section: '0002' });
const UNPUBLISHED = section({ section: '0003', publishedAt: null });

const report: BallotBoxReport = { municipality: 1066, zone: 4, section: 1, emittedAt: '', openedAt: '', closedAt: '', results: [] };

function fakeClient() {
  return {
    getSectionList: vi.fn<UrnaClient['getSectionList']>(async () => ({ kind: 'updated', etag: '"l1"', sections: [A, B, UNPUBLISHED] })),
    getAux: vi.fn<UrnaClient['getAux']>(async (s) => ({ kind: 'ready', hash: `h-${s.section}`, fileName: 'bu.dat' })),
    getReport: vi.fn<UrnaClient['getReport']>(async () => ({ kind: 'ok', report })),
    getCandidateNames: vi.fn<UrnaClient['getCandidateNames']>(async () => new Map()),
  };
}

function fakeRepository() {
  return {
    loadAll: vi.fn<SectionRepository['loadAll']>(async () => []),
    saveZone: vi.fn<SectionRepository['saveZone']>(async () => undefined),
  };
}

describe('createSectionPoller', () => {
  let client: ReturnType<typeof fakeClient>;
  let repository: ReturnType<typeof fakeRepository>;
  let store: SectionStore;
  let clock: FakeClock;
  const build = (jobBudgetMs = 60_000, states = ['ac']) =>
    createSectionPoller({ client, store, repository, clock, logger: silentLogger, states, concurrency: 2, jobBudgetMs });

  beforeEach(() => {
    client = fakeClient();
    repository = fakeRepository();
    store = createSectionStore();
    clock = new FakeClock();
  });

  it('fetches aux and BU for every published section on the first job', async () => {
    const stats = await build().pollOnce();
    expect(stats).toMatchObject({ statesChecked: 1, published: 2, due: 2, fetched: 2, stored: 2, deferred: 0 });
    expect(client.getAux).toHaveBeenCalledTimes(2);
    expect(client.getReport.mock.calls.map((c) => c[1])).toEqual(['h-0001', 'h-0002']);
    expect(store.get(A)?.hash).toBe('h-0001');
  });

  it('does not fetch a section again until its publication stamp changes', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getSectionList.mockResolvedValueOnce({ kind: 'not_modified' });
    expect(await poller.pollOnce()).toMatchObject({ statesUnchanged: 1, due: 0 });
    expect(client.getSectionList.mock.calls[1]?.[1]).toBe('"l1"');

    const republished = { ...A, publishedAt: '25/10/2026 22:00:00' };
    client.getSectionList.mockResolvedValueOnce({ kind: 'updated', etag: '"l2"', sections: [republished, B] });
    expect(await poller.pollOnce()).toMatchObject({ due: 1, fetched: 1 });
    expect(store.get(A)?.section.publishedAt).toBe('25/10/2026 22:00:00');
  });

  it('picks up sections that become published later', async () => {
    const poller = build();
    await poller.pollOnce();
    const nowPublished = { ...UNPUBLISHED, publishedAt: '25/10/2026 23:00:00' };
    client.getSectionList.mockResolvedValueOnce({ kind: 'updated', etag: '"l2"', sections: [A, B, nowPublished] });
    expect(await poller.pollOnce()).toMatchObject({ published: 3, due: 1, stored: 3 });
  });

  it.each([
    ['pending aux', 'aux', { kind: 'pending' }, 'pending'],
    ['missing aux', 'aux', { kind: 'not_found' }, 'pending'],
    ['invalid aux', 'aux', { kind: 'invalid' }, 'invalid'],
    ['missing BU', 'report', { kind: 'not_found' }, 'pending'],
    ['invalid BU', 'report', { kind: 'invalid', reason: 'x' }, 'invalid'],
  ] as const)('retries a section after a %s', async (_label, step, response, counter) => {
    if (step === 'aux') client.getAux.mockResolvedValueOnce(response as never);
    else client.getReport.mockResolvedValueOnce(response as never);
    const poller = build();
    expect((await poller.pollOnce())[counter]).toBe(1);
    expect(store.size).toBe(1);
    client.getSectionList.mockResolvedValueOnce({ kind: 'not_modified' });
    expect(await poller.pollOnce()).toMatchObject({ due: 1, fetched: 1, stored: 2 });
  });

  it('counts request failures and retries them next job', async () => {
    client.getAux.mockRejectedValueOnce(new Error('timeout'));
    const poller = build();
    expect((await poller.pollOnce()).failed).toBe(1);
    expect((await poller.pollOnce()).fetched).toBe(1);
  });

  it('does not count failures caused by an abort', async () => {
    const controller = new AbortController();
    client.getAux.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect((await build().pollOnce(controller.signal)).failed).toBe(0);
  });

  it('defers due sections once the job budget is spent', async () => {
    client.getReport.mockImplementation(async () => {
      clock.advance(40_000);
      return { kind: 'ok', report };
    });
    const sections: Section[] = Array.from({ length: 6 }, (_, i) => section({ section: String(i).padStart(4, '0') }));
    client.getSectionList.mockResolvedValue({ kind: 'updated', etag: null, sections });
    const poller = createSectionPoller({ client, store, repository, clock, logger: silentLogger, states: ['ac'], concurrency: 1, jobBudgetMs: 60_000 });
    const stats = await poller.pollOnce();
    expect(stats).toMatchObject({ due: 6, fetched: 2, deferred: 4 });
    clock.advance(1);
    expect(await poller.pollOnce()).toMatchObject({ due: 4, fetched: 2, deferred: 2 });
  });

  it.each(['not_found', 'invalid'] as const)('keeps the previous list when it comes back %s', async (kind) => {
    const poller = build();
    await poller.pollOnce();
    client.getSectionList.mockResolvedValueOnce({ kind });
    expect(await poller.pollOnce()).toMatchObject({ statesUnavailable: 1, published: 2, due: 0 });
    await poller.pollOnce();
    expect(client.getSectionList.mock.calls[2]?.[1]).toBeNull();
  });

  it('keeps the previous list when its request fails', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getSectionList.mockRejectedValueOnce(new Error('down'));
    expect(await poller.pollOnce()).toMatchObject({ statesUnavailable: 1, published: 2 });
  });

  it('treats a 304 without a cached list as unavailable', async () => {
    client.getSectionList.mockResolvedValueOnce({ kind: 'not_modified' });
    expect(await build().pollOnce()).toMatchObject({ statesUnavailable: 1, published: 0 });
  });

  it('reads one list per configured state', async () => {
    await build(60_000, ['ac', 'al']).pollOnce();
    expect(client.getSectionList.mock.calls.map((c) => c[0])).toEqual(['ac', 'al']);
  });

  describe('persistence', () => {
    const restoredA = { section: A, hash: 'h-0001', report };

    it('restores stored sections on the first job and does not download them again', async () => {
      repository.loadAll.mockResolvedValueOnce([restoredA]);
      const poller = build();
      expect(await poller.pollOnce()).toMatchObject({ restored: 1, due: 1, fetched: 1, stored: 2 });
      expect(client.getAux.mock.calls.map((c) => c[0].section)).toEqual(['0002']);
      await poller.pollOnce();
      expect(repository.loadAll).toHaveBeenCalledTimes(1);
    });

    it('downloads a restored section again when the TSE republished it', async () => {
      repository.loadAll.mockResolvedValueOnce([{ ...restoredA, section: { ...A, publishedAt: '25/10/2026 20:00:00' } }]);
      expect(await build().pollOnce()).toMatchObject({ restored: 1, due: 2 });
    });

    it('downloads everything when the state volume cannot be read, and tries to restore again', async () => {
      repository.loadAll.mockRejectedValueOnce(new Error('EACCES'));
      const poller = build();
      expect(await poller.pollOnce()).toMatchObject({ restored: 0, due: 2, fetched: 2 });
      await poller.pollOnce();
      expect(repository.loadAll).toHaveBeenCalledTimes(2);
    });

    it('writes each changed zone once at the end of the job', async () => {
      const other = section({ zone: '0005', section: '0001' });
      client.getSectionList.mockResolvedValueOnce({ kind: 'updated', etag: null, sections: [A, B, other] });
      expect((await build().pollOnce()).persistedZones).toBe(2);
      const saved = repository.saveZone.mock.calls.map(([zone, results]) => [zone.zone, results.map((r) => r.section.section).sort()]);
      expect(saved.sort()).toEqual([
        ['0004', ['0001', '0002']],
        ['0005', ['0001']],
      ]);
    });

    it('writes nothing when no section changed', async () => {
      const poller = build();
      await poller.pollOnce();
      repository.saveZone.mockClear();
      client.getSectionList.mockResolvedValueOnce({ kind: 'not_modified' });
      expect((await poller.pollOnce()).persistedZones).toBe(0);
      expect(repository.saveZone).not.toHaveBeenCalled();
    });

    it('keeps a zone that failed to persist and retries it next job', async () => {
      repository.saveZone.mockRejectedValueOnce(new Error('disk full'));
      const poller = build();
      expect((await poller.pollOnce()).persistedZones).toBe(0);
      client.getSectionList.mockResolvedValueOnce({ kind: 'not_modified' });
      expect((await poller.pollOnce()).persistedZones).toBe(1);
    });

    it('persists what was downloaded even when the job is aborted', async () => {
      const controller = new AbortController();
      client.getReport.mockImplementationOnce(async () => ({ kind: 'ok', report })).mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('aborted');
      });
      const p = createSectionPoller({ client, store, repository, clock, logger: silentLogger, states: ['ac'], concurrency: 1, jobBudgetMs: 60_000 });
      expect(await p.pollOnce(controller.signal)).toMatchObject({ fetched: 1, persistedZones: 1 });
    });
  });
});
