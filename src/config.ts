export interface AppConfig {
  baseUrl: string;
  cycle: string;
  electionCode: number;
  officeCodes: number[];
  /** Lowercase UF codes; empty means every state published for the election. */
  states: string[];
  outputDir: string;
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
    if (!/^[a-z]{2}$/.test(state)) problems.push(`STATES contains invalid UF "${state}"`);
  }

  const cycle = required('ELECTION_CYCLE');
  if (cycle && !/^ele\d{4}$/.test(cycle)) problems.push(`ELECTION_CYCLE must look like "ele2026", got "${cycle}"`);

  const config: AppConfig = {
    baseUrl: (env.TSE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    cycle,
    electionCode: positiveInt('ELECTION_CODE'),
    officeCodes,
    states,
    outputDir: required('OUTPUT_DIR'),
    pollIntervalMs: positiveInt('POLL_INTERVAL_SECONDS') * 1000,
    scheduleStart: optionalDate('SCHEDULE_START'),
    scheduleEnd: optionalDate('SCHEDULE_END'),
    maxRetries: nonNegativeInt('MAX_RETRIES', 3),
    retryBaseDelayMs: nonNegativeInt('RETRY_BASE_DELAY_MS', 1000),
    requestTimeoutMs: positiveInt('REQUEST_TIMEOUT_MS', 15000),
    concurrency: positiveInt('CONCURRENCY', 8),
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
