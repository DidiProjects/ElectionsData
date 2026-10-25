import { describe, expect, it } from 'vitest';
import { formatBrasilia, formatTseDateTime, formatUrnaTimestamp } from '../../src/export/format.js';

describe('formatBrasilia', () => {
  it('renders the instant in UTC-3', () => {
    expect(formatBrasilia(new Date('2026-10-25T20:15:00.789Z'))).toBe('2026-10-25 17:15:00');
  });

  it('crosses midnight correctly', () => {
    expect(formatBrasilia(new Date('2026-10-26T01:30:00Z'))).toBe('2026-10-25 22:30:00');
  });
});

describe('formatTseDateTime', () => {
  it('reorders dd/mm/yyyy into ISO-like order', () => {
    expect(formatTseDateTime('25/10/2026 21:08:17')).toBe('2026-10-25 21:08:17');
  });

  it('returns unexpected values unchanged', () => {
    expect(formatTseDateTime('soon')).toBe('soon');
  });
});

describe('formatUrnaTimestamp', () => {
  it('expands the compact ballot box timestamp', () => {
    expect(formatUrnaTimestamp('20261025T170205')).toBe('2026-10-25 17:02:05');
  });

  it('returns unexpected values unchanged', () => {
    expect(formatUrnaTimestamp('')).toBe('');
  });
});
