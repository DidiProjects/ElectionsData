import type { Section, SectionResult } from '../domain/types.js';

export interface SectionStore {
  set(result: SectionResult): void;
  get(section: Section): SectionResult | undefined;
  /** Every stored section, ordered by state, municipality, zone and section. */
  all(): SectionResult[];
  readonly size: number;
}

export const sectionKey = (s: Section): string => `${s.state}-${s.municipalityCode}-${s.zone}-${s.section}`;

export function createSectionStore(): SectionStore {
  const entries = new Map<string, SectionResult>();
  return {
    set: (result) => {
      entries.set(sectionKey(result.section), result);
    },
    get: (section) => entries.get(sectionKey(section)),
    // Map keys are unique, so the comparator never sees two equal keys.
    all: () => [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r),
    get size() {
      return entries.size;
    },
  };
}
