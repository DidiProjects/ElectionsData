import { describe, expect, it, vi } from 'vitest';
import { createCooldownGate } from '../../src/http/cooldownGate.js';
import { createHttpClient, HttpRequestError, parseRetryAfter, type FetchFn } from '../../src/http/httpClient.js';
import { silentLogger } from '../../src/logger.js';
import { emptyResponse, FakeClock, jsonResponse } from '../helpers.js';

const URL = 'https://tse.example/file.json';

function setup(responses: Array<Response | Error>, overrides: { maxRetries?: number; timeoutMs?: number } = {}) {
  const clock = new FakeClock('2026-10-25T20:00:00Z');
  const fetch = vi.fn<FetchFn>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const gate = createCooldownGate(clock);
  const client = createHttpClient({
    fetch,
    clock,
    gate,
    logger: silentLogger,
    maxRetries: overrides.maxRetries ?? 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    timeoutMs: overrides.timeoutMs ?? 15_000,
    userAgent: 'test-agent',
    random: () => 0.5,
  });
  return { client, fetch, clock, gate };
}

describe('parseRetryAfter', () => {
  const now = new Date('2026-10-25T20:00:00Z');
  it('parses seconds', () => expect(parseRetryAfter('7', now)).toBe(7000));
  it('parses HTTP dates', () => expect(parseRetryAfter('Sun, 25 Oct 2026 20:00:10 GMT', now)).toBe(10_000));
  it('clamps past dates to zero', () => expect(parseRetryAfter('Sun, 25 Oct 2026 19:00:00 GMT', now)).toBe(0));
  it('ignores missing or garbage values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('createHttpClient', () => {
  it('returns the parsed body and etag on 200', async () => {
    const { client, fetch } = setup([jsonResponse({ a: 1 }, { headers: { etag: '"v1"' } })]);
    await expect(client.getJson(URL)).resolves.toEqual({ kind: 'ok', body: { a: 1 }, etag: '"v1"' });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ 'User-Agent': 'test-agent' });
  });

  it('downloads binary bodies with getBytes', async () => {
    const { client } = setup([new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"b1"' } })]);
    const response = await client.getBytes(URL);
    expect(response).toEqual({ kind: 'ok', body: Buffer.from([1, 2, 3]), etag: '"b1"' });
  });

  it('retries getBytes like any other request', async () => {
    const { client, fetch } = setup([emptyResponse(503), new Response(new Uint8Array([9]), { status: 200 })]);
    await expect(client.getBytes(URL)).resolves.toMatchObject({ kind: 'ok', body: Buffer.from([9]) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends If-None-Match and reports not_modified on 304', async () => {
    const { client, fetch } = setup([emptyResponse(304)]);
    await expect(client.getJson(URL, { etag: '"v1"' })).resolves.toEqual({ kind: 'not_modified' });
    expect((fetch.mock.calls[0]?.[1].headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
  });

  it('reports not_found on 404 without retrying', async () => {
    const { client, fetch } = setup([emptyResponse(404)]);
    await expect(client.getJson(URL)).resolves.toEqual({ kind: 'not_found' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries network errors, 5xx and truncated JSON, then succeeds', async () => {
    const { client, fetch, clock } = setup([
      new Error('ECONNRESET'),
      emptyResponse(502),
      new Response('{"trunc', { status: 200 }),
      jsonResponse({ ok: true }),
    ]);
    await expect(client.getJson(URL)).resolves.toMatchObject({ kind: 'ok', body: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(4);
    // Full jitter with random()=0.5: half of 1s, 2s, 4s.
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it('gives up after maxRetries retries', async () => {
    const { client, fetch } = setup([emptyResponse(500), emptyResponse(500), emptyResponse(500), emptyResponse(500)]);
    const error = await client.getJson(URL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpRequestError);
    expect(error).toMatchObject({ url: URL, attempts: 4, status: 500 });
    expect((error as Error).message).toMatch(/failed after 4 attempts: HTTP 500/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry other client errors', async () => {
    const { client, fetch } = setup([emptyResponse(403)]);
    await expect(client.getJson(URL)).rejects.toMatchObject({ status: 403, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429 and pauses every worker through the gate', async () => {
    const { client, clock, gate } = setup([emptyResponse(429, { 'retry-after': '20' }), jsonResponse({})]);
    const pauseSpy = vi.spyOn(gate, 'pauseUntil');
    await client.getJson(URL);
    expect(clock.sleeps[0]).toBe(20_000);
    expect(pauseSpy).toHaveBeenCalledWith(new Date('2026-10-25T20:00:20Z'));
  });

  it('caps the backoff at maxDelayMs', async () => {
    const responses = Array.from({ length: 8 }, () => emptyResponse(500));
    const { client, clock } = setup(responses, { maxRetries: 7 });
    await client.getJson(URL).catch(() => undefined);
    expect(Math.max(...clock.sleeps)).toBe(15_000);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const clock = new FakeClock();
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });
    const client = createHttpClient({
      fetch,
      clock,
      gate: createCooldownGate(clock),
      logger: silentLogger,
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      timeoutMs: 5,
      userAgent: 'x',
    });
    await expect(client.getJson(URL)).rejects.toThrow(/network error: aborted by timeout/);
  });

  it('stops retrying once the caller aborts', async () => {
    const { client, fetch } = setup([emptyResponse(500), emptyResponse(500)]);
    const controller = new AbortController();
    fetch.mockImplementationOnce(async () => {
      controller.abort();
      return emptyResponse(500);
    });
    await expect(client.getJson(URL, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
