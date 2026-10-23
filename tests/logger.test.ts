import { describe, expect, it } from 'vitest';
import { createJsonLogger, silentLogger } from '../src/logger.js';

describe('createJsonLogger', () => {
  const fixedNow = () => new Date('2026-10-25T20:00:00Z');

  it('writes one JSON line per entry with fields merged in', () => {
    const lines: string[] = [];
    const logger = createJsonLogger('debug', (l) => lines.push(l), fixedNow);
    logger.info('hello', { a: 1 });
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: '2026-10-25T20:00:00.000Z',
      level: 'info',
      message: 'hello',
      a: 1,
    });
  });

  it('drops entries below the minimum level', () => {
    const lines: string[] = [];
    const logger = createJsonLogger('warn', (l) => lines.push(l), fixedNow);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('silentLogger accepts every level without output', () => {
    expect(() => {
      silentLogger.debug('x');
      silentLogger.info('x');
      silentLogger.warn('x');
      silentLogger.error('x');
    }).not.toThrow();
  });
});
