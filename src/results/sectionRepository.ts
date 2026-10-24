import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SectionResult } from '../domain/types.js';
import type { Logger } from '../logger.js';

/**
 * Decoded BUs on disk, so a restart or redeploy does not download them again.
 * One JSON file per electoral zone: a new section rewrites its zone (a few hundred
 * sections), not the whole state (SP alone has ~104k).
 */
export interface SectionRepository {
  loadAll(): Promise<SectionResult[]>;
  /** Replaces the stored zone with exactly these results. */
  saveZone(zone: ZoneRef, results: readonly SectionResult[]): Promise<void>;
}

export interface ZoneRef {
  state: string;
  municipalityCode: string;
  zone: string;
}

export const zoneKey = (z: ZoneRef): string => `${z.state}-${z.municipalityCode}-${z.zone}`;

interface ZoneFile {
  version: 1;
  pleitoCode: number;
  sections: SectionResult[];
}

const FILE_VERSION = 1;

type UnknownRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is UnknownRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSectionResult(value: unknown): value is SectionResult {
  if (!isRecord(value) || typeof value.hash !== 'string') return false;
  const s = value.section;
  const r = value.report;
  return (
    isRecord(s) &&
    ['state', 'municipalityCode', 'municipalityName', 'zone', 'section'].every((k) => typeof s[k] === 'string') &&
    Array.isArray(s.aggregated) &&
    typeof s.publishedAt === 'string' &&
    isRecord(r) &&
    Array.isArray(r.results) &&
    r.results.every((o) => isRecord(o) && Array.isArray(o.votes))
  );
}

export function createSectionRepository(options: { stateDir: string; pleitoCode: number; logger: Logger }): SectionRepository {
  const root = path.join(options.stateDir, `p${options.pleitoCode}`);
  const fileOf = (z: ZoneRef): string => path.join(root, z.state, `${z.municipalityCode}-${z.zone}.json`);

  return {
    async loadAll() {
      let states: string[];
      try {
        states = await fs.readdir(root);
      } catch {
        return [];
      }
      const results: SectionResult[] = [];
      for (const state of states) {
        for (const name of await fs.readdir(path.join(root, state))) {
          if (!name.endsWith('.json')) continue;
          const file = path.join(root, state, name);
          try {
            const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
            const valid =
              isRecord(parsed) &&
              parsed.version === FILE_VERSION &&
              parsed.pleitoCode === options.pleitoCode &&
              Array.isArray(parsed.sections) &&
              parsed.sections.every(isSectionResult);
            if (!valid) throw new Error('unexpected content');
            results.push(...(parsed as unknown as ZoneFile).sections);
          } catch (error) {
            // Its sections are simply downloaded again; nothing else depends on the file.
            options.logger.warn('ignoring unreadable state file', { file, error: (error as Error).message });
          }
        }
      }
      return results;
    },

    async saveZone(zone, results) {
      const file = fileOf(zone);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const content: ZoneFile = { version: FILE_VERSION, pleitoCode: options.pleitoCode, sections: [...results] };
      // Write-then-rename: a crash mid-write leaves the previous zone file intact.
      const temp = `${file}.tmp`;
      await fs.writeFile(temp, JSON.stringify(content), 'utf8');
      await fs.rename(temp, file);
    },
  };
}
