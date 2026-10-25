import type { RawAuxFile, RawCandidateFile, RawSectionList } from './rawTypes.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isArrayOf = <T>(value: unknown, item: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.every(item);

const isSection = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.ns) &&
  (value.nsa === undefined || isArrayOf(value.nsa, isString)) &&
  (value.nsp === undefined || isString(value.nsp)) &&
  (value.da === undefined || isString(value.da)) &&
  (value.ha === undefined || isString(value.ha));

export function isRawSectionList(value: unknown): value is RawSectionList {
  if (!isRecord(value) || !isString(value.cdp) || !Array.isArray(value.abr)) return false;
  return value.abr.every(
    (state) =>
      isRecord(state) &&
      isString(state.cd) &&
      Array.isArray(state.mu) &&
      state.mu.every(
        (m) =>
          isRecord(m) &&
          isString(m.cd) &&
          isString(m.nm) &&
          Array.isArray(m.zon) &&
          m.zon.every((z) => isRecord(z) && isString(z.cd) && Array.isArray(z.sec) && z.sec.every(isSection)),
      ),
  );
}

export function isRawAuxFile(value: unknown): value is RawAuxFile {
  return (
    isRecord(value) &&
    isString(value.st) &&
    Array.isArray(value.hashes) &&
    value.hashes.every(
      (h) =>
        isRecord(h) &&
        isString(h.hash) &&
        isString(h.st) &&
        isString(h.dr) &&
        isString(h.hr) &&
        Array.isArray(h.arq) &&
        h.arq.every((a) => isRecord(a) && isString(a.nm) && isString(a.tp)),
    )
  );
}

export function isRawCandidateFile(value: unknown): value is RawCandidateFile {
  return (
    isRecord(value) &&
    Array.isArray(value.carg) &&
    value.carg.every(
      (c) =>
        isRecord(c) &&
        Array.isArray(c.agr) &&
        c.agr.every(
          (a) =>
            isRecord(a) &&
            Array.isArray(a.par) &&
            a.par.every(
              (p) =>
                isRecord(p) &&
                (p.cand === undefined ||
                  isArrayOf(p.cand, (x): x is unknown => isRecord(x) && isString(x.n) && isString(x.nmu))),
            ),
        ),
    )
  );
}
