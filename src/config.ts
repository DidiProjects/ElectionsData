/**
 * job: scheduled window of periodic jobs (the long-running worker).
 * backfill: one-off load — runs jobs back to back until every published BU is stored, then exits.
 */
export type RunMode = 'job' | 'backfill';

export interface AppConfig {
  mode: RunMode;
  baseUrl: string;
  cycle: string;
  /** "Pleito" groups every election held on the same day (e.g. 3221 = 2026 2nd round). */
  pleitoCode: number;
  officeCodes: number[];
  /** Lowercase UF codes; "zz" is abroad. */
  states: string[];
  outputDir: string;
  /** Postgres holding the decoded BUs, so they survive restarts and redeploys. */
  databaseUrl: string;
  outputPrefix: string;
  maxVersions: number;
  pollIntervalMs: number;
  scheduleStart: Date | null;
  scheduleEnd: Date | null;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  concurrency: number;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_BASE_URL = 'https://resultados.tse.jus.br/oficial';
export const MIN_POLL_INTERVAL_SECONDS = 30;
export const ALL_STATES = [
  'ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms', 'mt', 'pa',
  'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se', 'sp', 'to', 'zz',
];

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
      problems.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const positiveInt = (key: string, fallback?: number): number => {
    const raw = env[key]?.trim();
    if (!raw) {
      if (fallback === undefined) problems.push(`${key} is required`);
      return fallback ?? 0;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`${key} must be a positive integer, got "${raw}"`);
      return fallback ?? 0;
    }
    return value;
  };

  const nonNegativeInt = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${key} must be a non-negative integer, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const optionalDate = (key: string): Date | null => {
    const raw = env[key]?.trim();
    if (!raw) return null;
    // Without an explicit offset the server timezone would silently decide the window.
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      problems.push(`${key} must be ISO 8601 with timezone (e.g. 2026-10-25T17:00:00-03:00), got "${raw}"`);
      return null;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      problems.push(`${key} is not a valid date, got "${raw}"`);
      return null;
    }
    return date;
  };

  const officeCodes = (required('OFFICE_CODES') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const value = Number(s);
      if (!Number.isInteger(value) || value <= 0) problems.push(`OFFICE_CODES contains invalid code "${s}"`);
      return value;
    });

  const states = (env.STATES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const state of states) {
    if (!ALL_STATES.includes(state)) problems.push(`STATES contains invalid UF "${state}"`);
  }

  const mode = (env.MODE?.trim().toLowerCase() || 'job') as RunMode;
  if (mode !== 'job' && mode !== 'backfill') problems.push(`MODE must be "job" or "backfill", got "${env.MODE}"`);

  const outputPrefix = env.OUTPUT_PREFIX?.trim() || 'secoes';
  if (!/^[A-Za-z0-9_-]+$/.test(outputPrefix)) {
    problems.push(`OUTPUT_PREFIX may only contain letters, digits, "_" and "-", got "${outputPrefix}"`);
  }

  const cycle = required('ELECTION_CYCLE');
  if (cycle && !/^ele\d{4}$/.test(cycle)) problems.push(`ELECTION_CYCLE must look like "ele2026", got "${cycle}"`);

  const config: AppConfig = {
    mode,
    baseUrl: (env.TSE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    cycle,
    pleitoCode: positiveInt('PLEITO_CODE'),
    officeCodes,
    states: states.length > 0 ? states : [...ALL_STATES],
    outputDir: required('OUTPUT_DIR'),
    databaseUrl: required('DATABASE_URL'),
    outputPrefix,
    maxVersions: positiveInt('MAX_CSV_VERSIONS', 1000),
    pollIntervalMs: positiveInt('POLL_INTERVAL_SECONDS') * 1000,
    scheduleStart: optionalDate('SCHEDULE_START'),
    scheduleEnd: optionalDate('SCHEDULE_END'),
    maxRetries: nonNegativeInt('MAX_RETRIES', 3),
    retryBaseDelayMs: nonNegativeInt('RETRY_BASE_DELAY_MS', 1000),
    requestTimeoutMs: positiveInt('REQUEST_TIMEOUT_MS', 15000),
    // Measured on the 2026 first round: ~4,000 sections/min at 64 with no throttling,
    // i.e. about 2h for the whole country.
    concurrency: positiveInt('CONCURRENCY', 64),
  };

  // TSE serves these files with Cache-Control max-age≈52s; polling faster only adds load.
  if (config.pollIntervalMs > 0 && config.pollIntervalMs < MIN_POLL_INTERVAL_SECONDS * 1000) {
    problems.push(`POLL_INTERVAL_SECONDS must be at least ${MIN_POLL_INTERVAL_SECONDS}`);
  }

  if (config.scheduleStart && config.scheduleEnd && config.scheduleEnd <= config.scheduleStart) {
    problems.push('SCHEDULE_END must be after SCHEDULE_START');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
