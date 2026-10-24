import type { SectionResult } from '../domain/types.js';
import { formatTseDateTime, formatUrnaTimestamp } from './format.js';

export const CSV_COLUMNS = [
  'data_geracao',
  'SG_UF',
  'CD_MUNICIPIO',
  'NM_MUNICIPIO',
  'NR_ZONA',
  'NR_SECAO',
  'SECOES_AGREGADAS',
  'CD_ELEICAO',
  'CD_CARGO',
  'DS_CARGO',
  'TP_VOTO',
  'NR_VOTAVEL',
  'NM_VOTAVEL',
  'QT_VOTOS',
  'QT_APTOS',
  'QT_COMPARECIMENTO',
  'dt_totalizacao',
  'dt_abertura',
  'dt_encerramento',
  'dt_emissao_bu',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Record<CsvColumn, string | number>;

const OFFICE_NAMES: Record<number, string> = {
  1: 'Presidente',
  3: 'Governador',
  5: 'Senador',
  6: 'Deputado Federal',
  7: 'Deputado Estadual',
  8: 'Deputado Distrital',
  11: 'Prefeito',
  13: 'Vereador',
};

export const officeName = (code: number): string => OFFICE_NAMES[code] ?? `Cargo ${code}`;

export type NameLookup = (electionId: number, officeCode: number, state: string, number: number) => string;

/** One row per section x office x votable, in the BU's own print order. */
export function* toCsvRows(
  results: Iterable<SectionResult>,
  officeCodes: ReadonlySet<number>,
  generatedAt: string,
  nameOf: NameLookup,
): Generator<CsvRow> {
  for (const { section, report } of results) {
    for (const office of report.results) {
      if (!officeCodes.has(office.officeCode)) continue;
      for (const vote of office.votes) {
        yield {
          data_geracao: generatedAt,
          SG_UF: section.state.toUpperCase(),
          CD_MUNICIPIO: section.municipalityCode,
          NM_MUNICIPIO: section.municipalityName,
          NR_ZONA: Number(section.zone),
          NR_SECAO: Number(section.section),
          SECOES_AGREGADAS: section.aggregated.map(Number).join(';'),
          CD_ELEICAO: office.electionId,
          CD_CARGO: office.officeCode,
          DS_CARGO: officeName(office.officeCode),
          TP_VOTO: vote.type,
          NR_VOTAVEL: vote.number ?? '',
          NM_VOTAVEL:
            vote.type === 'nominal' && vote.number !== null
              ? nameOf(office.electionId, office.officeCode, section.state, vote.number)
              : '',
          QT_VOTOS: vote.votes,
          QT_APTOS: office.eligible,
          QT_COMPARECIMENTO: office.turnout,
          dt_totalizacao: section.publishedAt ? formatTseDateTime(section.publishedAt) : '',
          dt_abertura: formatUrnaTimestamp(report.openedAt),
          dt_encerramento: formatUrnaTimestamp(report.closedAt),
          dt_emissao_bu: formatUrnaTimestamp(report.emittedAt),
        };
      }
    }
  }
}

export function escapeCsvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_HEADER = `${CSV_COLUMNS.join(',')}\n`;

export function serializeCsvRow(row: CsvRow): string {
  return `${CSV_COLUMNS.map((column) => escapeCsvField(row[column])).join(',')}\n`;
}
