import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

export interface WriteOutcome {
  version: number;
  versionPath: string;
  currentPath: string;
  pruned: string[];
}

export interface VersionedCsvWriter {
  /**
   * Streams `chunks` into `<prefix>_<N>.csv` (N = highest on disk + 1), refreshes
   * `<prefix>_current.csv`, and keeps only the newest `maxVersions` numbered files.
   */
  write(chunks: Iterable<string>): Promise<WriteOutcome>;
}

export interface VersionedCsvWriterOptions {
  outputDir: string;
  prefix: string;
  maxVersions: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function streamToFile(filePath: string, chunks: Iterable<string>): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  try {
    // Full-country files reach hundreds of MB: stream instead of building one string.
    let buffer = '';
    for (const chunk of chunks) {
      buffer += chunk;
      if (buffer.length >= 1 << 20) {
        if (!stream.write(buffer)) await once(stream, 'drain');
        buffer = '';
      }
    }
    stream.end(buffer);
    await once(stream, 'finish');
  } catch (error) {
    // The file is opened asynchronously: wait for close, or a later cleanup could run
    // before the open and leave the temp file behind.
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    throw error;
  }
}

export function createVersionedCsvWriter(options: VersionedCsvWriterOptions): VersionedCsvWriter {
  const versionFile = new RegExp(`^${escapeRegExp(options.prefix)}_(\\d+)\\.csv$`);
  const currentPath = path.join(options.outputDir, `${options.prefix}_current.csv`);

  const listVersions = async (): Promise<Array<{ name: string; n: number }>> =>
    (await fs.readdir(options.outputDir))
      .map((name) => ({ name, match: versionFile.exec(name) }))
      .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
      .map((f) => ({ name: f.name, n: Number(f.match[1]) }))
      .sort((a, b) => a.n - b.n);

  return {
    async write(chunks) {
      await fs.mkdir(options.outputDir, { recursive: true });
      // Taken from disk every time, so numbering survives restarts and manual cleanups.
      const existing = await listVersions();
      const version = (existing.at(-1)?.n ?? -1) + 1;
      const versionPath = path.join(options.outputDir, `${options.prefix}_${version}.csv`);

      // Write-then-rename so a reader never sees a half-written file.
      const tempPath = `${versionPath}.tmp`;
      try {
        await streamToFile(tempPath, chunks);
        await fs.rename(tempPath, versionPath);
      } catch (error) {
        await fs.rm(tempPath, { force: true });
        throw error;
      }

      const currentTemp = `${currentPath}.tmp`;
      await fs.copyFile(versionPath, currentTemp);
      await fs.rename(currentTemp, currentPath);

      const all = [...existing, { name: path.basename(versionPath), n: version }];
      const pruned = all.slice(0, Math.max(0, all.length - options.maxVersions)).map((f) => f.name);
      await Promise.all(pruned.map((name) => fs.rm(path.join(options.outputDir, name), { force: true })));
      return { version, versionPath, currentPath, pruned };
    },
  };
}
