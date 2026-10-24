import { describe, expect, it } from 'vitest';
import { ALL_STATES, ConfigError, loadConfig, type Env } from '../src/config.js';

const base: Env = {
  ELECTION_CYCLE: 'ele2026',
  PLEITO_CODE: '3221',
  OFFICE_CODES: '1, 3',
  OUTPUT_DIR: '/data/output',
  DATABASE_URL: 'postgresql://elections:secret@elections-postgres:5432/elections',
  POLL_INTERVAL_SECONDS: '60',
};

const problemsOf = (env: Env): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe('loadConfig', () => {
  it('parses a minimal environment and applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toEqual({
      mode: 'job',
      baseUrl: 'https://resultados.tse.jus.br/oficial',
      cycle: 'ele2026',
      pleitoCode: 3221,
      officeCodes: [1, 3],
      states: ALL_STATES,
      outputDir: '/data/output',
      databaseUrl: 'postgresql://elections:secret@elections-postgres:5432/elections',
      outputPrefix: 'secoes',
      maxVersions: 1000,
      pollIntervalMs: 60_000,
      scheduleStart: null,
      scheduleEnd: null,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      requestTimeoutMs: 15000,
      concurrency: 8,
    });
  });

  it('reads optional values', () => {
    const config = loadConfig({
      ...base,
      TSE_BASE_URL: 'http://mirror.local/oficial/',
      STATES: 'SP, rj',
      OUTPUT_PREFIX: 'secoes_2t2026',
      MODE: ' Backfill ',
      MAX_CSV_VERSIONS: '50',
      SCHEDULE_START: '2026-10-25T17:00:00-03:00',
      SCHEDULE_END: '2026-10-26T06:00:00Z',
      MAX_RETRIES: '0',
      RETRY_BASE_DELAY_MS: '250',
      REQUEST_TIMEOUT_MS: '5000',
      CONCURRENCY: '2',
    });
    expect(config.baseUrl).toBe('http://mirror.local/oficial');
    expect(config.states).toEqual(['sp', 'rj']);
    expect(config.mode).toBe('backfill');
    expect(config.outputPrefix).toBe('secoes_2t2026');
    expect(config.maxVersions).toBe(50);
    expect(config.scheduleStart?.toISOString()).toBe('2026-10-25T20:00:00.000Z');
    expect(config.scheduleEnd?.toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(config.maxRetries).toBe(0);
    expect(config.retryBaseDelayMs).toBe(250);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.concurrency).toBe(2);
  });

  it('reports every missing required variable at once', () => {
    expect(problemsOf({})).toEqual(
      expect.arrayContaining([
        'OFFICE_CODES is required',
        'ELECTION_CYCLE is required',
        'PLEITO_CODE is required',
        'OUTPUT_DIR is required',
        'DATABASE_URL is required',
        'POLL_INTERVAL_SECONDS is required',
      ]),
    );
  });

  it.each([
    [{ MODE: 'once' }, 'MODE must be "job" or "backfill", got "once"'],
    [{ PLEITO_CODE: 'abc' }, 'PLEITO_CODE must be a positive integer, got "abc"'],
    [{ OFFICE_CODES: '1,x' }, 'OFFICE_CODES contains invalid code "x"'],
    [{ STATES: 'sao' }, 'STATES contains invalid UF "sao"'],
    [{ STATES: 'xx' }, 'STATES contains invalid UF "xx"'],
    [{ OUTPUT_PREFIX: 'a/b' }, 'OUTPUT_PREFIX may only contain letters, digits, "_" and "-", got "a/b"'],
    [{ MAX_CSV_VERSIONS: '0' }, 'MAX_CSV_VERSIONS must be a positive integer, got "0"'],
    [{ ELECTION_CYCLE: '2026' }, 'ELECTION_CYCLE must look like "ele2026", got "2026"'],
    [{ MAX_RETRIES: '-1' }, 'MAX_RETRIES must be a non-negative integer, got "-1"'],
    [{ POLL_INTERVAL_SECONDS: '10' }, 'POLL_INTERVAL_SECONDS must be at least 30'],
    [{ POLL_INTERVAL_SECONDS: '0' }, 'POLL_INTERVAL_SECONDS must be a positive integer, got "0"'],
  ])('rejects %o', (override, problem) => {
    expect(problemsOf({ ...base, ...override })).toContain(problem);
  });

  it('requires an explicit timezone on schedule dates', () => {
    expect(problemsOf({ ...base, SCHEDULE_START: '2026-10-25T17:00:00' })[0]).toMatch(/must be ISO 8601 with timezone/);
  });

  it('rejects unparseable schedule dates', () => {
    expect(problemsOf({ ...base, SCHEDULE_END: '2026-13-45T99:00:00Z' })[0]).toMatch(/not a valid date/);
  });

  it('rejects a window that ends before it starts', () => {
    expect(
      problemsOf({ ...base, SCHEDULE_START: '2026-10-26T00:00:00Z', SCHEDULE_END: '2026-10-25T00:00:00Z' }),
    ).toContain('SCHEDULE_END must be after SCHEDULE_START');
  });

  it('formats problems into the error message', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration:\n- /);
  });
});
