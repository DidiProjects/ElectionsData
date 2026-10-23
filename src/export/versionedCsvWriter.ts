import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.js';

export interface WriteOutcome {
  written: boolean;
  filePath: string | null;
  pruned: string[];
}

export interface VersionedCsvWriter {
  /** Writes `<prefix>_<timestamp>.csv` unless identical to the newest version; keeps the last N. */
  write(prefix: string, content: string): Promise<WriteOutcome>;
}

export interface VersionedCsvWriterOptions {
  outputDir: string;
  maxVersions: number;
  clock: Clock;
}

/** 2026-10-25T20:30:15.123Z -> 20261025T203015123Z: sortable as plain text. */
export function formatVersionTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

const VERSION_SUFFIX = /_\d{8}T\d{9}Z\.csv$/;

export function createVersionedCsvWriter(options: VersionedCsvWriterOptions): VersionedCsvWriter {
  const lastContent = new Map<string, string>();

  const listVersions = async (prefix: string): Promise<string[]> => {
    const files = await fs.readdir(options.outputDir);
    return files.filter((name) => VERSION_SUFFIX.test(name) && name.replace(VERSION_SUFFIX, '') === prefix).sort();
  };

  return {
    async write(prefix, content) {
      await fs.mkdir(options.outputDir, { recursive: true });
      const existing = await listVersions(prefix);

      if (!lastContent.has(prefix) && existing.length > 0) {
        // After a restart, compare against what is already on disk.
        lastContent.set(prefix, await fs.readFile(path.join(options.outputDir, existing.at(-1) as string), 'utf8'));
      }
      if (lastContent.get(prefix) === content) return { written: false, filePath: null, pruned: [] };

      const fileName = `${prefix}_${formatVersionTimestamp(options.clock.now())}.csv`;
      const filePath = path.join(options.outputDir, fileName);
      // Write-then-rename so a reader never sees a half-written version.
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, filePath);
      lastContent.set(prefix, content);

      const versions = [...new Set([...existing, fileName])].sort();
      const pruned = versions.slice(0, Math.max(0, versions.length - options.maxVersions));
      await Promise.all(pruned.map((name) => fs.rm(path.join(options.outputDir, name), { force: true })));
      return { written: true, filePath, pruned };
    },
  };
}
