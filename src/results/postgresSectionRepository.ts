import type { Database, Queryable } from '../db/database.js';
import type { SectionResult } from '../domain/types.js';
import { formatTseDateTime, formatUrnaTimestamp } from '../export/format.js';
import type { BuOfficeResult, VoteType } from '../urna/bu.js';
import type { CandidateKey, CandidateSink, SectionRepository } from './sectionRepository.js';

const pad = (value: number, size: number): string => String(value).padStart(size, '0');

/** "YYYYMMDDTHHMMSS" -> "YYYY-MM-DD HH:MM:SS", or null when the ballot box wrote something else. */
const urnaTimestampOrNull = (value: string): string | null => {
  const formatted = formatUrnaTimestamp(value);
  return formatted === value ? null : formatted;
};

interface SectionRow extends Record<string, unknown> {
  id: string;
  sg_uf: string;
  cd_municipio: string;
  nm_municipio: string;
  nr_zona: number;
  nr_secao: number;
  secoes_agregadas: number[];
  publicacao_tse: string;
  hash_bu: string;
  dt_abertura: string | null;
  dt_encerramento: string | null;
  dt_emissao_bu: string | null;
}

interface ResultRow extends Record<string, unknown> {
  id: string;
  secao_id: string;
  cd_eleicao: number;
  cd_cargo: number;
  qt_aptos: number;
  qt_comparecimento: number;
}

interface VoteRow extends Record<string, unknown> {
  resultado_id: string;
  tp_voto: VoteType;
  nr_votavel: number | null;
  qt_votos: number;
}

const COMPACT = `'YYYYMMDD"T"HH24MISS'`;

const sectionKeyOf = (uf: string, mun: string, zone: number, section: number): string => `${uf}|${mun}|${zone}|${section}`;

async function upsertSections(tx: Queryable, pleitoCode: number, results: readonly SectionResult[]): Promise<string[]> {
  const col = <T>(pick: (r: SectionResult) => T): T[] => results.map(pick);
  // Arrays of arrays would be flattened by unnest, so aggregated sections travel as "1;2".
  const rows = await tx.query<{ id: string; sg_uf: string; cd_municipio: string; nr_zona: number; nr_secao: number }>(
    `INSERT INTO secao (cd_pleito, sg_uf, cd_municipio, nm_municipio, nr_zona, nr_secao, secoes_agregadas,
                        publicacao_tse, dt_totalizacao, hash_bu, dt_abertura, dt_encerramento, dt_emissao_bu)
     SELECT $1, u.uf, u.mun, u.nome, u.zona, u.secao,
            CASE WHEN u.agregadas = '' THEN '{}'::integer[] ELSE string_to_array(u.agregadas, ';')::integer[] END,
            u.publicacao, u.totalizacao::timestamp, u.hash, u.abertura::timestamp, u.encerramento::timestamp, u.emissao::timestamp
     FROM unnest($2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::text[],
                 $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]) WITH ORDINALITY
          AS u(uf, mun, nome, zona, secao, agregadas, publicacao, totalizacao, hash, abertura, encerramento, emissao, n)
     ORDER BY u.n
     ON CONFLICT (cd_pleito, sg_uf, cd_municipio, nr_zona, nr_secao) DO UPDATE SET
       nm_municipio = EXCLUDED.nm_municipio, secoes_agregadas = EXCLUDED.secoes_agregadas,
       publicacao_tse = EXCLUDED.publicacao_tse, dt_totalizacao = EXCLUDED.dt_totalizacao, hash_bu = EXCLUDED.hash_bu,
       dt_abertura = EXCLUDED.dt_abertura, dt_encerramento = EXCLUDED.dt_encerramento,
       dt_emissao_bu = EXCLUDED.dt_emissao_bu, atualizado_em = now()
     RETURNING id, sg_uf, cd_municipio, nr_zona, nr_secao`,
    [
      pleitoCode,
      col((r) => r.section.state),
      col((r) => r.section.municipalityCode),
      col((r) => r.section.municipalityName),
      col((r) => Number(r.section.zone)),
      col((r) => Number(r.section.section)),
      col((r) => r.section.aggregated.map(Number).join(';')),
      col((r) => r.section.publishedAt as string),
      col((r) => formatTseDateTime(r.section.publishedAt as string)),
      col((r) => r.hash),
      col((r) => urnaTimestampOrNull(r.report.openedAt)),
      col((r) => urnaTimestampOrNull(r.report.closedAt)),
      col((r) => urnaTimestampOrNull(r.report.emittedAt)),
    ],
  );
  // RETURNING order is not guaranteed, so ids are matched back by natural key.
  const idByKey = new Map(rows.map((r) => [sectionKeyOf(r.sg_uf, r.cd_municipio, r.nr_zona, r.nr_secao), r.id]));
  return results.map(
    (r) =>
      idByKey.get(sectionKeyOf(r.section.state, r.section.municipalityCode, Number(r.section.zone), Number(r.section.section))) as string,
  );
}

async function insertResults(tx: Queryable, sectionIds: readonly string[], results: readonly SectionResult[]): Promise<void> {
  const offices: Array<{ sectionId: string; office: BuOfficeResult }> = results.flatMap((r, i) =>
    r.report.results.map((office) => ({ sectionId: sectionIds[i] as string, office })),
  );
  if (offices.length === 0) return;

  const inserted = await tx.query<{ id: string; secao_id: string; cd_eleicao: number; cd_cargo: number }>(
    `INSERT INTO resultado_cargo (secao_id, cd_eleicao, cd_cargo, qt_aptos, qt_comparecimento)
     SELECT * FROM unnest($1::bigint[], $2::integer[], $3::integer[], $4::integer[], $5::integer[])
     RETURNING id, secao_id, cd_eleicao, cd_cargo`,
    [
      offices.map((o) => o.sectionId),
      offices.map((o) => o.office.electionId),
      offices.map((o) => o.office.officeCode),
      offices.map((o) => o.office.eligible),
      offices.map((o) => o.office.turnout),
    ],
  );

  const officeKey = (sectionId: string, election: number, office: number): string => `${sectionId}|${election}|${office}`;
  const idByKey = new Map(inserted.map((r) => [officeKey(r.secao_id, r.cd_eleicao, r.cd_cargo), r.id]));
  const votes = offices.flatMap((o) => {
    const resultId = idByKey.get(officeKey(o.sectionId, o.office.electionId, o.office.officeCode)) as string;
    return o.office.votes.map((v, order) => ({ resultId, order, v }));
  });
  if (votes.length === 0) return;
  await tx.query(
    `INSERT INTO voto (resultado_id, ordem, tp_voto, nr_votavel, qt_votos)
     SELECT * FROM unnest($1::bigint[], $2::integer[], $3::text[], $4::integer[], $5::integer[])`,
    [
      votes.map((x) => x.resultId),
      votes.map((x) => x.order),
      votes.map((x) => x.v.type),
      votes.map((x) => x.v.number),
      votes.map((x) => x.v.votes),
    ],
  );
}

export function createPostgresSectionRepository(db: Database, pleitoCode: number): SectionRepository & CandidateSink {
  return {
    async loadAll() {
      const sections = await db.query<SectionRow>(
        `SELECT id, sg_uf, cd_municipio, nm_municipio, nr_zona, nr_secao, secoes_agregadas, publicacao_tse, hash_bu,
                to_char(dt_abertura, ${COMPACT}) AS dt_abertura, to_char(dt_encerramento, ${COMPACT}) AS dt_encerramento,
                to_char(dt_emissao_bu, ${COMPACT}) AS dt_emissao_bu
         FROM secao WHERE cd_pleito = $1`,
        [pleitoCode],
      );
      const offices = await db.query<ResultRow>(
        `SELECT r.id, r.secao_id, r.cd_eleicao, r.cd_cargo, r.qt_aptos, r.qt_comparecimento
         FROM resultado_cargo r JOIN secao s ON s.id = r.secao_id
         WHERE s.cd_pleito = $1 ORDER BY r.id`,
        [pleitoCode],
      );
      const votes = await db.query<VoteRow>(
        `SELECT v.resultado_id, v.tp_voto, v.nr_votavel, v.qt_votos
         FROM voto v JOIN resultado_cargo r ON r.id = v.resultado_id JOIN secao s ON s.id = r.secao_id
         WHERE s.cd_pleito = $1 ORDER BY v.resultado_id, v.ordem`,
        [pleitoCode],
      );

      const votesByResult = new Map<string, BuOfficeResult['votes']>();
      for (const v of votes) {
        const list = votesByResult.get(v.resultado_id) ?? [];
        list.push({ type: v.tp_voto, number: v.nr_votavel, votes: v.qt_votos });
        votesByResult.set(v.resultado_id, list);
      }
      const officesBySection = new Map<string, BuOfficeResult[]>();
      for (const o of offices) {
        const list = officesBySection.get(o.secao_id) ?? [];
        list.push({
          electionId: o.cd_eleicao,
          officeCode: o.cd_cargo,
          eligible: o.qt_aptos,
          turnout: o.qt_comparecimento,
          votes: votesByResult.get(o.id) ?? [],
        });
        officesBySection.set(o.secao_id, list);
      }

      return sections.map((s) => ({
        section: {
          state: s.sg_uf,
          municipalityCode: s.cd_municipio,
          municipalityName: s.nm_municipio,
          zone: pad(s.nr_zona, 4),
          section: pad(s.nr_secao, 4),
          aggregated: s.secoes_agregadas.map((n) => pad(n, 4)),
          publishedAt: s.publicacao_tse,
        },
        hash: s.hash_bu,
        report: {
          municipality: Number(s.cd_municipio),
          zone: s.nr_zona,
          section: s.nr_secao,
          emittedAt: s.dt_emissao_bu ?? '',
          openedAt: s.dt_abertura ?? '',
          closedAt: s.dt_encerramento ?? '',
          results: officesBySection.get(s.id) ?? [],
        },
      }));
    },

    async save(results) {
      if (results.length === 0) return;
      await db.transaction(async (tx) => {
        const ids = await upsertSections(tx, pleitoCode, results);
        // A republished BU replaces everything below its section.
        await tx.query('DELETE FROM resultado_cargo WHERE secao_id = ANY($1::bigint[])', [ids]);
        await insertResults(tx, ids, results);
      });
    },

    async saveCandidates(key, names) {
      if (names.size === 0) return;
      const entries = [...names];
      await db.query(
        `INSERT INTO candidato (cd_eleicao, cd_cargo, sg_uf, nr_votavel, nm_votavel)
         SELECT $1, $2, $3, u.nr, u.nm FROM unnest($4::integer[], $5::text[]) AS u(nr, nm)
         ON CONFLICT (cd_eleicao, cd_cargo, sg_uf, nr_votavel) DO UPDATE SET nm_votavel = EXCLUDED.nm_votavel`,
        [key.electionId, key.officeCode, key.state, entries.map(([n]) => n), entries.map(([, nm]) => nm)],
      );
    },
  };
}
