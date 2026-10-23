import type {
  RawCandidate,
  RawMunicipalityConfig,
  RawMunicipalityResult,
  RawOffice,
  RawTrackingFile,
} from './rawTypes.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isNumericString = (value: unknown): value is string => isString(value) && /^\d+$/.test(value);

const hasStrings = (value: UnknownRecord, keys: string[]): boolean => keys.every((k) => isString(value[k]));

export function isRawMunicipalityConfig(value: unknown): value is RawMunicipalityConfig {
  if (!isRecord(value) || !Array.isArray(value.abr)) return false;
  return value.abr.every(
    (state) =>
      isRecord(state) &&
      isString(state.cd) &&
      Array.isArray(state.mu) &&
      state.mu.every((m) => isRecord(m) && hasStrings(m, ['cd', 'cdi', 'nm'])),
  );
}

export function isRawTrackingFile(value: unknown): value is RawTrackingFile {
  if (!isRecord(value) || !isString(value.ele) || !Array.isArray(value.abr)) return false;
  return value.abr.every(
    (entry) =>
      isRecord(entry) &&
      hasStrings(entry, ['tpabr', 'cdabr', 'and', 'dt', 'ht']) &&
      isRecord(entry.s) &&
      isString(entry.s.st),
  );
}

function isRawCandidate(value: unknown): value is RawCandidate {
  return isRecord(value) && hasStrings(value, ['n', 'nm', 'nmu']) && isNumericString(value.vap);
}

function isRawOffice(value: unknown): value is RawOffice {
  return (
    isRecord(value) &&
    hasStrings(value, ['cd', 'nmn']) &&
    Array.isArray(value.agr) &&
    value.agr.every(
      (agr) =>
        isRecord(agr) &&
        Array.isArray(agr.par) &&
        agr.par.every(
          (par) =>
            isRecord(par) &&
            isString(par.sg) &&
            (par.cand === undefined || (Array.isArray(par.cand) && par.cand.every(isRawCandidate))),
        ),
    )
  );
}

/**
 * A result is valid only if it is structurally complete *and* it is the file we asked for.
 * Anything else is discarded so the previously stored value survives.
 */
export function isValidMunicipalityResult(
  value: unknown,
  expected: { electionCode: number; municipalityCode: string; officeCode: number },
): value is RawMunicipalityResult {
  if (!isRecord(value)) return false;
  if (!hasStrings(value, ['t', 'tpabr', 'dg', 'hg', 'dt', 'ht', 'and'])) return false;
  if (!isNumericString(value.ele) || Number(value.ele) !== expected.electionCode) return false;
  if (value.cdabr !== expected.municipalityCode) return false;
  if (!isNumericString(value.idg)) return false;
  if (!isRecord(value.s) || !isNumericString(value.s.ts) || !isNumericString(value.s.st)) return false;
  if (!isRecord(value.e) || !['te', 'c', 'a'].every((k) => isNumericString((value.e as UnknownRecord)[k]))) return false;
  if (!isRecord(value.v) || !['vv', 'vb', 'tvn'].every((k) => isNumericString((value.v as UnknownRecord)[k]))) return false;
  if (!Array.isArray(value.carg) || !value.carg.every(isRawOffice)) return false;
  if (!value.carg.some((office) => Number((office as RawOffice).cd) === expected.officeCode)) return false;
  return Number(value.s.st) <= Number(value.s.ts);
}
