import { describe, expect, it } from 'vitest';
import { BerError } from '../../src/urna/ber.js';
import { decodeBallotBoxReport } from '../../src/urna/bu.js';
import { buildBallotBoxReport, der } from '../helpers.js';

const president = {
  electionId: 6258,
  officeCode: 1,
  eligible: 300,
  turnout: 250,
  votes: [
    { type: 1, votes: 120, number: 13 },
    { type: 1, votes: 110, number: 22 },
    { type: 2, votes: 5 },
    { type: 3, votes: 15 },
  ],
};

describe('decodeBallotBoxReport', () => {
  it('decodes identity, times and votes per office', () => {
    const bu = buildBallotBoxReport({
      municipality: 1066,
      zone: 4,
      section: 77,
      offices: [president],
      emittedAt: '20261025T170205',
      openedAt: '20261025T080001',
      closedAt: '20261025T170002',
    });
    expect(decodeBallotBoxReport(bu)).toEqual({
      municipality: 1066,
      zone: 4,
      section: 77,
      emittedAt: '20261025T170205',
      openedAt: '20261025T080001',
      closedAt: '20261025T170002',
      results: [
        {
          electionId: 6258,
          officeCode: 1,
          eligible: 300,
          turnout: 250,
          votes: [
            { type: 'nominal', number: 13, votes: 120 },
            { type: 'nominal', number: 22, votes: 110 },
            { type: 'branco', number: null, votes: 5 },
            { type: 'nulo', number: null, votes: 15 },
          ],
        },
      ],
    });
  });

  it('decodes several elections and offices in one BU', () => {
    const bu = buildBallotBoxReport({
      municipality: 1,
      zone: 2,
      section: 3,
      offices: [
        president,
        { electionId: 6260, officeCode: 3, eligible: 300, turnout: 249, votes: [{ type: 1, votes: 249, number: 40 }] },
      ],
    });
    expect(decodeBallotBoxReport(bu).results.map((r) => [r.electionId, r.officeCode, r.turnout])).toEqual([
      [6258, 1, 250],
      [6260, 3, 249],
    ]);
  });

  it('maps legend votes, unknown vote types and a missing quantity', () => {
    const bu = buildBallotBoxReport({
      municipality: 1,
      zone: 2,
      section: 3,
      offices: [
        {
          electionId: 6259,
          officeCode: 6,
          eligible: 10,
          turnout: 9,
          votes: [{ type: 4, votes: 3, party: 13, number: 13 }, { type: 9, votes: 1 }, { type: 1, number: 1313 }],
        },
      ],
    });
    expect(decodeBallotBoxReport(bu).results[0]?.votes).toEqual([
      { type: 'legenda', number: 13, votes: 3 },
      { type: 'tipo_9', number: null, votes: 1 },
      { type: 'nominal', number: 1313, votes: 0 },
    ]);
  });

  it('skips referendum questions (non-constitutional office choice)', () => {
    const bu = buildBallotBoxReport({ municipality: 1, zone: 2, section: 3, offices: [president] });
    // Rewrite the office choice [1] -> [2] the way a referendum question is encoded.
    const marker = Buffer.from([0x81, 0x01, 0x01, 0x02, 0x01, 0x01]);
    const at = bu.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const patched = Buffer.from(bu);
    patched[at] = 0x82;
    expect(decodeBallotBoxReport(patched).results).toEqual([]);
  });

  it.each([
    ['no envelope', Buffer.alloc(0)],
    ['an envelope without content', der.seq(der.int(1))],
    ['content without the report fields', der.seq(der.octets(der.seq(der.int(1))))],
  ])('rejects %s', (_label, buffer) => {
    expect(() => decodeBallotBoxReport(buffer)).toThrow(BerError);
  });
});
