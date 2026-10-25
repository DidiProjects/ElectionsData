import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, CSV_HEADER, escapeCsvField, officeName, serializeCsvRow, toCsvRows } from '../../src/export/csv.js';
import type { SectionResult } from '../../src/domain/types.js';
import { section } from '../helpers.js';

const result: SectionResult = {
  section: section({ aggregated: ['0101', '0102'] }),
  hash: 'h',
  report: {
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
          { type: 'branco', number: null, votes: 5 },
        ],
      },
      { electionId: 6260, officeCode: 3, eligible: 300, turnout: 249, votes: [{ type: 'nominal', number: 40, votes: 249 }] },
    ],
  },
};

const names = (electionId: number, officeCode: number, state: string, number: number) =>
  `${electionId}/${officeCode}/${state}/${number}`;

describe('toCsvRows', () => {
  it('produces one row per section x office x votable', () => {
    const rows = [...toCsvRows([result], new Set([1]), '2026-10-25 21:15:00', names)];
    expect(rows).toEqual([
      {
        data_geracao: '2026-10-25 21:15:00',
        SG_UF: 'AC',
        CD_MUNICIPIO: '01066',
        NM_MUNICIPIO: 'CIDADE TESTE',
        NR_ZONA: 4,
        NR_SECAO: 77,
        SECOES_AGREGADAS: '101;102',
        CD_ELEICAO: 6258,
        CD_CARGO: 1,
        DS_CARGO: 'Presidente',
        TP_VOTO: 'nominal',
        NR_VOTAVEL: 13,
        NM_VOTAVEL: '6258/1/ac/13',
        QT_VOTOS: 120,
        QT_APTOS: 300,
        QT_COMPARECIMENTO: 250,
        dt_totalizacao: '2026-10-25 21:00:00',
        dt_abertura: '2026-10-25 08:00:01',
        dt_encerramento: '2026-10-25 17:00:02',
        dt_emissao_bu: '2026-10-25 17:02:05',
      },
      expect.objectContaining({ TP_VOTO: 'branco', NR_VOTAVEL: '', NM_VOTAVEL: '', QT_VOTOS: 5 }),
    ]);
    expect(Object.keys(rows[0] ?? {})).toEqual([...CSV_COLUMNS]);
  });

  it('includes every configured office and skips the others', () => {
    const offices = [...toCsvRows([result], new Set([1, 3]), 'x', names)].map((r) => r.DS_CARGO);
    expect(offices).toEqual(['Presidente', 'Presidente', 'Governador']);
    expect([...toCsvRows([result], new Set([5]), 'x', names)]).toEqual([]);
  });

  it('leaves the publication time empty when unknown', () => {
    const unpublished = { ...result, section: section({ publishedAt: null }) };
    expect([...toCsvRows([unpublished], new Set([1]), 'x', names)][0]?.dt_totalizacao).toBe('');
  });
});

describe('officeName', () => {
  it('names known offices and falls back for others', () => {
    expect(officeName(3)).toBe('Governador');
    expect(officeName(25)).toBe('Cargo 25');
  });
});

describe('serialization', () => {
  it.each([
    ['plain', 'plain'],
    [42, '42'],
    ['A, B', '"A, B"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
  ])('escapes %j as %j', (input, output) => expect(escapeCsvField(input)).toBe(output));

  it('writes the header and rows in column order', () => {
    expect(CSV_HEADER).toBe(`${CSV_COLUMNS.join(',')}\n`);
    const [row] = toCsvRows([result], new Set([1]), '2026-10-25 21:15:00', () => 'NOME, COM VIRGULA');
    expect(serializeCsvRow(row!)).toBe(
      '2026-10-25 21:15:00,AC,01066,CIDADE TESTE,4,77,101;102,6258,1,Presidente,nominal,13,"NOME, COM VIRGULA",120,300,250,' +
        '2026-10-25 21:00:00,2026-10-25 08:00:01,2026-10-25 17:00:02,2026-10-25 17:02:05\n',
    );
  });
});
