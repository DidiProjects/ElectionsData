import type { MunicipalityResult, PollTarget } from '../domain/types.js';

export interface StoredResult {
  result: MunicipalityResult;
  etag: string | null;
}

export type UpdateOutcome = 'stored' | 'stale';

export interface ResultStore {
  get(target: PollTarget): StoredResult | undefined;
  /** Keeps the previous value when the incoming one is older (lower generation id). */
  update(target: PollTarget, result: MunicipalityResult, etag: string | null): UpdateOutcome;
  byOffice(officeCode: number): MunicipalityResult[];
  /** Bumped on every accepted update; lets the exporter skip unchanged snapshots cheaply. */
  revision(officeCode: number): number;
}

export const targetKey = (target: PollTarget): string =>
  `${target.municipality.state}${target.municipality.code}-c${target.officeCode}`;

export function createResultStore(): ResultStore {
  const entries = new Map<string, StoredResult>();
  const revisions = new Map<number, number>();

  return {
    get: (target) => entries.get(targetKey(target)),

    update(target, result, etag) {
      const key = targetKey(target);
      const previous = entries.get(key);
      if (previous && result.generationId < previous.result.generationId) return 'stale';
      entries.set(key, { result, etag });
      revisions.set(target.officeCode, (revisions.get(target.officeCode) ?? 0) + 1);
      return 'stored';
    },

    byOffice(officeCode) {
      const results: MunicipalityResult[] = [];
      for (const { result } of entries.values()) {
        if (result.officeCode === officeCode) results.push(result);
      }
      return results.sort(
        (a, b) =>
          a.municipality.state.localeCompare(b.municipality.state) ||
          a.municipality.code.localeCompare(b.municipality.code),
      );
    },

    revision: (officeCode) => revisions.get(officeCode) ?? 0,
  };
}
