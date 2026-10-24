import { describe, expect, it, vi } from 'vitest';
import { createCandidateDirectory } from '../../src/export/candidateDirectory.js';
import { silentLogger, type Logger } from '../../src/logger.js';
import type { UrnaClient } from '../../src/urna/urnaClient.js';

const client = (impl: UrnaClient['getCandidateNames']): UrnaClient => ({
  getSectionList: vi.fn(),
  getAux: vi.fn(),
  getReport: vi.fn(),
  getCandidateNames: vi.fn(impl),
});

describe('createCandidateDirectory', () => {
  it('loads names once per election, office and state', async () => {
    const c = client(async (_e, state) => new Map([[13, `LULA-${state}`]]));
    const dir = createCandidateDirectory(c, silentLogger);
    const key = { electionId: 6258, officeCode: 1, state: 'al' };
    await dir.load([key, key, { ...key, state: 'ba' }]);
    await dir.load([key]);
    expect(c.getCandidateNames).toHaveBeenCalledTimes(2);
    expect(dir.nameOf(6258, 1, 'al', 13)).toBe('LULA-al');
    expect(dir.nameOf(6258, 1, 'ba', 13)).toBe('LULA-ba');
  });

  it('returns an empty name for unknown candidates or unloaded keys', async () => {
    const dir = createCandidateDirectory(client(async () => new Map()), silentLogger);
    await dir.load([{ electionId: 6258, officeCode: 1, state: 'al' }]);
    expect(dir.nameOf(6258, 1, 'al', 28)).toBe('');
    expect(dir.nameOf(6260, 3, 'ac', 40)).toBe('');
  });

  it('logs a failed load and retries it on the next call', async () => {
    const logger: Logger = { ...silentLogger, warn: vi.fn() };
    const getNames = vi
      .fn<UrnaClient['getCandidateNames']>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(new Map([[22, 'X']]));
    const dir = createCandidateDirectory(client(getNames), logger);
    const key = { electionId: 6258, officeCode: 1, state: 'al' };
    await dir.load([key]);
    expect(logger.warn).toHaveBeenCalledWith('candidate names unavailable, leaving them blank for now', {
      ...key,
      error: 'down',
    });
    await dir.load([key]);
    expect(dir.nameOf(6258, 1, 'al', 22)).toBe('X');
  });
});
