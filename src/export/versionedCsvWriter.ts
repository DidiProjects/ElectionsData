import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.js';

export interface WriteOutcome {
  written: boolean;
  versionPath: string | null;
  latestPath: string;
  pruned: string[];
}

export interface VersionedCsvWriter {
  /**
   * Writes `<prefix>/<timestamp>.csv` and refreshes `<prefix>.csv` (fixed name, newest content)
   * unless the content is identical to the newest version; keeps the last N versions.
   */
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

const VERSION_FILE = /^\d{8}T\d{9}Z\.csv$/;

async function writeAtomically(filePath: string, content: string): Promise<void> {
  // Write-then-rename so a reader never sees a half-written file.
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

const exists = (filePath: string): Promise<boolean> =>
  fs.access(filePath).then(
    () => true,
    () => false,
  );

export function createVersionedCsvWriter(options: VersionedCsvWriterOptions): VersionedCsvWriter {
  const lastContent = new Map<string, string>();

  return {
    async write(prefix, content) {
      const versionsDir = path.join(options.outputDir, prefix);
      const latestPath = path.join(options.outputDir, `${prefix}.csv`);
      await fs.mkdir(versionsDir, { recursive: true });
      const existing = (await fs.readdir(versionsDir)).filter((name) => VERSION_FILE.test(name)).sort();

      if (!lastContent.has(prefix) && existing.length > 0) {
        // After a restart, compare against what is already on disk.
        lastContent.set(prefix, await fs.readFile(path.join(versionsDir, existing.at(-1) as string), 'utf8'));
      }
      if (lastContent.get(prefix) === content) {
        if (!(await exists(latestPath))) await writeAtomically(latestPath, content);
        return { written: false, versionPath: null, latestPath, pruned: [] };
      }

      const fileName = `${formatVersionTimestamp(options.clock.now())}.csv`;
      const versionPath = path.join(versionsDir, fileName);
      await writeAtomically(versionPath, content);
      await writeAtomically(latestPath, content);
      lastContent.set(prefix, content);

      const versions = [...new Set([...existing, fileName])].sort();
      const pruned = versions.slice(0, Math.max(0, versions.length - options.maxVersions));
      await Promise.all(pruned.map((name) => fs.rm(path.join(versionsDir, name), { force: true })));
      return { written: true, versionPath, latestPath, pruned };
    },
  };
}
