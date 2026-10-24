import type { Section, SectionResult } from '../domain/types.js';

export interface SectionStore {
  set(result: SectionResult): void;
  get(section: Section): SectionResult | undefined;
  /** Every stored section, ordered by state, municipality, zone and section. */
  all(): SectionResult[];
  inZone(state: string, municipalityCode: string, zone: string): SectionResult[];
  readonly size: number;
}

export const sectionKey = (s: Section): string => `${s.state}-${s.municipalityCode}-${s.zone}-${s.section}`;

const zoneOf = (s: { state: string; municipalityCode: string; zone: string }): string =>
  `${s.state}-${s.municipalityCode}-${s.zone}`;

// Map keys are unique, so the comparator never sees two equal keys.
const byKey = <T>([a]: [string, T], [b]: [string, T]): number => (a < b ? -1 : 1);

export function createSectionStore(): SectionStore {
  // Indexed by zone: persistence rewrites one zone at a time.
  const zones = new Map<string, Map<string, SectionResult>>();
  let size = 0;

  return {
    set: (result) => {
      const zone = zoneOf(result.section);
      const sections = zones.get(zone) ?? new Map<string, SectionResult>();
      const key = sectionKey(result.section);
      if (!sections.has(key)) size++;
      sections.set(key, result);
      zones.set(zone, sections);
    },
    get: (section) => zones.get(zoneOf(section))?.get(sectionKey(section)),
    all: () =>
      [...zones.entries()]
        .sort(byKey)
        .flatMap(([, sections]) => [...sections.entries()].sort(byKey).map(([, r]) => r)),
    inZone: (state, municipalityCode, zone) => [...(zones.get(zoneOf({ state, municipalityCode, zone }))?.values() ?? [])],
    get size() {
      return size;
    },
  };
}
