import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { CooldownGate } from './cooldownGate.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type HttpResponse<T> =
  | { kind: 'ok'; body: T; etag: string | null }
  | { kind: 'not_modified' }
  | { kind: 'not_found' };

export type JsonResponse = HttpResponse<unknown>;

export interface RequestOptions {
  etag?: string | null;
  signal?: AbortSignal;
}

export interface HttpClient {
  getJson(url: string, options?: RequestOptions): Promise<JsonResponse>;
  getBytes(url: string, options?: RequestOptions): Promise<HttpResponse<Buffer>>;
}

type BodyReader<T> = (response: Response) => Promise<T>;

export interface HttpClientOptions {
  fetch: FetchFn;
  clock: Clock;
  gate: CooldownGate;
  logger: Logger;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  random?: () => number;
}

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly attempts: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

class RetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const random = options.random ?? Math.random;

  const backoffMs = (retryIndex: number): number => {
    // Full jitter: spreads retries from concurrent workers instead of syncing them into bursts.
    const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** retryIndex);
    return Math.floor(random() * cap);
  };

  const attemptOnce = async <T>(
    url: string,
    read: BodyReader<T>,
    etag: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<HttpResponse<T>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        'User-Agent': options.userAgent,
      };
      if (etag) headers['If-None-Match'] = etag;

      let response: Response;
      try {
        response = await options.fetch(url, { headers, signal: controller.signal });
      } catch (error) {
        throw new RetryableError(`network error: ${(error as Error).message}`);
      }

      if (response.status === 304) return { kind: 'not_modified' };
      if (response.status === 404) return { kind: 'not_found' };
      if (RETRYABLE_STATUS.has(response.status)) {
        throw new RetryableError(
          `HTTP ${response.status}`,
          response.status,
          parseRetryAfter(response.headers.get('retry-after'), options.clock.now()),
        );
      }
      if (!response.ok) {
        throw new HttpRequestError(`HTTP ${response.status}`, url, 1, response.status);
      }

      let body: T;
      try {
        body = await read(response);
      } catch (error) {
        // A file caught mid-publication can come back truncated; worth another try.
        throw new RetryableError(`unreadable body: ${(error as Error).message}`, response.status);
      }
      return { kind: 'ok', body, etag: response.headers.get('etag') };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const request = async <T>(url: string, read: BodyReader<T>, { etag, signal }: RequestOptions = {}) => {
    let lastError: RetryableError | undefined;
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      if (signal?.aborted) break;
      await options.gate.wait(signal);
      try {
        return await attemptOnce(url, read, etag, signal);
      } catch (error) {
        if (error instanceof HttpRequestError) {
          throw new HttpRequestError(error.message, url, attempt + 1, error.status);
        }
        lastError = error as RetryableError;
      }
      if (attempt === options.maxRetries) break;

      const throttled = lastError.status === 429 || lastError.status === 503;
      const delay = Math.max(backoffMs(attempt), lastError.retryAfterMs ?? 0);
      if (throttled) {
        options.gate.pauseUntil(new Date(options.clock.now().getTime() + delay));
      }
      options.logger.debug('retrying request', { url, attempt: attempt + 1, delayMs: delay, reason: lastError.message });
      await options.clock.sleep(delay, signal);
    }
    throw new HttpRequestError(
      signal?.aborted ? 'aborted' : `failed after ${options.maxRetries + 1} attempts: ${lastError?.message}`,
      url,
      options.maxRetries + 1,
      lastError?.status,
    );
  };

  return {
    getJson: (url, requestOptions) => request(url, (r) => r.json() as Promise<unknown>, requestOptions),
    getBytes: (url, requestOptions) =>
      request(url, async (r) => Buffer.from(await r.arrayBuffer()), requestOptions),
  };
}
