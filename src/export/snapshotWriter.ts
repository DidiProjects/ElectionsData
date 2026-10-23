import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../clock.js';

export interface CsvFile {
  name: string;
  content: string;
}

export interface SnapshotOutcome {
  snapshotDir: string;
  latestPaths: string[];
}

export interface SnapshotWriter {
  /**
   * Writes every file into a new `<timestamp>/` folder, then replaces the same-named
   * files at the output root so they always hold the newest complete job.
   */
  write(files: readonly CsvFile[]): Promise<SnapshotOutcome>;
}

export interface SnapshotWriterOptions {
  outputDir: string;
  clock: Clock;
}

/** 2026-10-25T20:30:15.123Z -> 20261025T203015123Z: sortable as plain text. */
export function formatSnapshotTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  // Write-then-rename so a reader never sees a half-written file.
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

export function createSnapshotWriter(options: SnapshotWriterOptions): SnapshotWriter {
  return {
    async write(files) {
      const stamp = formatSnapshotTimestamp(options.clock.now());
      const snapshotDir = path.join(options.outputDir, stamp);
      // Built under a hidden name and renamed at the end, so a listed folder is always complete.
      const stagingDir = path.join(options.outputDir, `.${stamp}.tmp`);

      await fs.mkdir(stagingDir, { recursive: true });
      await Promise.all(files.map((file) => fs.writeFile(path.join(stagingDir, file.name), file.content, 'utf8')));
      await fs.rename(stagingDir, snapshotDir);

      const latestPaths = files.map((file) => path.join(options.outputDir, file.name));
      for (const [index, file] of files.entries()) await writeAtomically(latestPaths[index] as string, file.content);
      return { snapshotDir, latestPaths };
    },
  };
}
