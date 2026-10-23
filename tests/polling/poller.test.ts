import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Municipality } from '../../src/domain/types.js';
import { silentLogger } from '../../src/logger.js';
import { createPoller } from '../../src/polling/poller.js';
import { createResultStore, type ResultStore } from '../../src/results/resultStore.js';
import { mapMunicipalityResult } from '../../src/tse/mapper.js';
import type { Conditional, TrackingSnapshot, TseClient } from '../../src/tse/tseClient.js';
import { municipality, rawResult } from '../helpers.js';

const A = municipality({ code: '00001' });
const B = municipality({ code: '00002' });

const resultFor = (m: Municipality, officeCode = 1, idg = '1') =>
  mapMunicipalityResult(
    rawResult({ cdabr: m.code, idg, carg: [{ ...rawResult().carg[0]!, cd: String(officeCode) }] }),
    m,
    officeCode,
  );

const snapshot = (entries: Record<string, string>): Conditional<TrackingSnapshot> => ({
  kind: 'updated',
  etag: '"t"',
  value: new Map(Object.entries(entries)),
});

function fakeClient() {
  return {
    getMunicipalities: vi.fn<TseClient['getMunicipalities']>(async () => [A, B]),
    getTracking: vi.fn<TseClient['getTracking']>(async () => snapshot({ '00001': 'f1', '00002': 'f1' })),
    getMunicipalityResult: vi.fn<TseClient['getMunicipalityResult']>(async (m, officeCode) => ({
      kind: 'updated',
      etag: `"${m.code}-${officeCode}"`,
      value: resultFor(m, officeCode),
    })),
  };
}

describe('createPoller', () => {
  let client: ReturnType<typeof fakeClient>;
  let store: ResultStore;
  const build = (officeCodes = [1]) =>
    createPoller({ client, store, logger: silentLogger, states: ['ac'], officeCodes, concurrency: 2 });

  beforeEach(() => {
    client = fakeClient();
    store = createResultStore();
  });

  it('fetches every target on the first cycle', async () => {
    const stats = await build([1, 3]).pollOnce();
    expect(client.getMunicipalities).toHaveBeenCalledWith(['ac'], undefined);
    expect(client.getTracking).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ statesChecked: 1, targetsDue: 4, updated: 4, failed: 0 });
    expect(store.byOffice(1)).toHaveLength(2);
    expect(store.byOffice(3)).toHaveLength(2);
  });

  it('skips municipalities whose fingerprint did not change', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockResolvedValueOnce(snapshot({ '00001': 'f1', '00002': 'f2' }));
    const stats = await poller.pollOnce();
    expect(stats.targetsDue).toBe(1);
    expect(client.getMunicipalityResult).toHaveBeenCalledTimes(3);
    expect(client.getMunicipalityResult.mock.calls[2]?.[0]).toEqual(B);
  });

  it('makes no result requests when the tracking file is unchanged (304)', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockResolvedValueOnce({ kind: 'not_modified' });
    const stats = await poller.pollOnce();
    expect(stats).toMatchObject({ statesUnchanged: 1, targetsDue: 0 });
    expect(client.getTracking.mock.calls[1]?.[1]).toBe('"t"');
    expect(client.getMunicipalityResult).toHaveBeenCalledTimes(2);
  });

  it('sends the stored etag when re-fetching a result', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockResolvedValueOnce(snapshot({ '00001': 'f2', '00002': 'f1' }));
    await poller.pollOnce();
    expect(client.getMunicipalityResult.mock.calls[2]?.[2]).toBe('"00001-1"');
  });

  it.each(['not_found', 'invalid'] as const)(
    'falls back to conditional fetch of every municipality when tracking is %s',
    async (kind) => {
      const poller = build();
      await poller.pollOnce();
      client.getTracking.mockResolvedValueOnce({ kind });
      client.getMunicipalityResult.mockResolvedValue({ kind: 'not_modified' });
      const stats = await poller.pollOnce();
      expect(stats).toMatchObject({ statesUnavailable: 1, targetsDue: 2, notModified: 2 });
    },
  );

  it('falls back when the tracking request throws, and forgets the stale etag', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockRejectedValueOnce(new Error('boom'));
    expect((await poller.pollOnce()).statesUnavailable).toBe(1);
    await poller.pollOnce();
    expect(client.getTracking.mock.calls[2]?.[1]).toBeNull();
  });

  it('treats a 304 without a cached snapshot as unavailable', async () => {
    client.getTracking.mockResolvedValueOnce({ kind: 'not_modified' });
    expect(await build().pollOnce()).toMatchObject({ statesUnavailable: 1, targetsDue: 2 });
  });

  it('fetches a municipality missing from the tracking file every cycle', async () => {
    client.getTracking.mockResolvedValue(snapshot({ '00001': 'f1' }));
    const poller = build();
    await poller.pollOnce();
    expect((await poller.pollOnce()).targetsDue).toBe(1);
  });

  it('does not refetch a not_found target until its fingerprint changes', async () => {
    client.getMunicipalityResult.mockResolvedValue({ kind: 'not_found' });
    const poller = build();
    expect((await poller.pollOnce()).notFound).toBe(2);
    expect((await poller.pollOnce()).targetsDue).toBe(0);
  });

  it('keeps the previous value and retries next cycle after an invalid result', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockResolvedValue(snapshot({ '00001': 'f2', '00002': 'f1' }));
    client.getMunicipalityResult.mockResolvedValueOnce({ kind: 'invalid' });
    expect((await poller.pollOnce()).invalid).toBe(1);
    expect(store.get({ municipality: A, officeCode: 1 })?.result.generationId).toBe(1);
    expect((await poller.pollOnce()).targetsDue).toBe(1);
  });

  it('keeps the previous value and retries next cycle after a failed request', async () => {
    const poller = build();
    await poller.pollOnce();
    client.getTracking.mockResolvedValue(snapshot({ '00001': 'f2', '00002': 'f1' }));
    client.getMunicipalityResult.mockRejectedValueOnce(new Error('timeout'));
    expect((await poller.pollOnce()).failed).toBe(1);
    expect(store.get({ municipality: A, officeCode: 1 })).toBeDefined();
    expect((await poller.pollOnce()).targetsDue).toBe(1);
  });

  it('does not count failures caused by an abort', async () => {
    const controller = new AbortController();
    client.getMunicipalityResult.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect((await build().pollOnce(controller.signal)).failed).toBe(0);
  });

  it('retries loading the municipality list on the next cycle', async () => {
    client.getMunicipalities.mockRejectedValueOnce(new Error('down'));
    const poller = build();
    expect(await poller.pollOnce()).toMatchObject({ statesChecked: 0, targetsDue: 0 });
    expect((await poller.pollOnce()).updated).toBe(2);
    await poller.pollOnce();
    expect(client.getMunicipalities).toHaveBeenCalledTimes(2);
  });
});
