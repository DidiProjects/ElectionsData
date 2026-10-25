import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrator.js';
import type { SectionResult } from '../../src/domain/types.js';
import { silentLogger } from '../../src/logger.js';
import { createPostgresSectionRepository } from '../../src/results/postgresSectionRepository.js';
import { createTestDatabase, describeDb, MIGRATIONS_DIR, type TestDatabase } from '../db/testDatabase.js';
import { section } from '../helpers.js';

const result = (sectionNumber: string, overrides: Partial<SectionResult> = {}): SectionResult => ({
  section: section({ section: sectionNumber, aggregated: sectionNumber === '0001' ? ['0101', '0102'] : [] }),
  hash: `h${sectionNumber}`,
  report: {
    municipality: 1066,
    zone: 4,
    section: Number(sectionNumber),
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
      { electionId: 6260, officeCode: 3, eligible: 300, turnout: 249, votes: [{ type: 'nominal', number: 40, votes: 249 }] },
    ],
  },
  ...overrides,
});

describeDb('createPostgresSectionRepository', () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    await runMigrations(t.db, MIGRATIONS_DIR, silentLogger);
  });
  afterEach(() => t.drop());

  const repo = (pleito = 3221) => createPostgresSectionRepository(t.db, pleito);

  it('loads nothing from an empty database and ignores empty saves', async () => {
    await repo().save([]);
    await expect(repo().loadAll()).resolves.toEqual([]);
  });

  it('round-trips sections exactly, with every office and vote in order', async () => {
    const saved = [result('0001'), result('0002')];
    await repo().save(saved);
    const loaded = await repo().loadAll();
    expect(loaded.sort((a, b) => a.hash.localeCompare(b.hash))).toEqual(saved);
  });

  it('replaces a republished section instead of duplicating it', async () => {
    await repo().save([result('0001')]);
    const republished = result('0001', {
      hash: 'h-new',
      section: { ...section({ section: '0001' }), publishedAt: '25/10/2026 22:30:00' },
    });
    republished.report.results = [{ electionId: 6258, officeCode: 1, eligible: 300, turnout: 1, votes: [{ type: 'nulo', number: null, votes: 1 }] }];
    await repo().save([republished]);
    const loaded = await repo().loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(republished);
    const votes = await t.db.query<{ n: string }>('SELECT count(*) AS n FROM voto');
    expect(Number(votes[0]?.n)).toBe(1);
  });

  it('keeps pleitos apart', async () => {
    await repo(3220).save([result('0001')]);
    await expect(repo(3221).loadAll()).resolves.toEqual([]);
    await expect(repo(3220).loadAll()).resolves.toHaveLength(1);
  });

  it('stores unparseable ballot box times as null and restores them empty', async () => {
    const odd = result('0003');
    odd.report = { ...odd.report, openedAt: 'garbage', closedAt: '', emittedAt: '' };
    await repo().save([odd]);
    const [loaded] = await repo().loadAll();
    expect(loaded?.report).toMatchObject({ openedAt: '', closedAt: '', emittedAt: '' });
  });

  it('saves a section whose BU has no results', async () => {
    const empty = result('0004');
    empty.report = { ...empty.report, results: [] };
    await repo().save([empty]);
    expect((await repo().loadAll())[0]?.report.results).toEqual([]);
  });

  it('saves an office whose BU lists no votes', async () => {
    const noVotes = result('0005');
    noVotes.report = { ...noVotes.report, results: [{ electionId: 6258, officeCode: 1, eligible: 10, turnout: 0, votes: [] }] };
    await repo().save([noVotes]);
    expect((await repo().loadAll())[0]?.report.results[0]?.votes).toEqual([]);
  });

  it('stores candidate names and serves the long format through the votos_secao view', async () => {
    await repo().save([result('0001')]);
    await repo().saveCandidates({ electionId: 6258, officeCode: 1, state: 'ac' }, new Map([[13, 'CANDIDATO TREZE']]));
    await repo().saveCandidates({ electionId: 6258, officeCode: 1, state: 'ac' }, new Map([[13, 'TREZE RENOMEADO'], [22, 'VINTE E DOIS']]));
    await repo().saveCandidates({ electionId: 6258, officeCode: 1, state: 'ac' }, new Map());

    const rows = await t.db.query<Record<string, unknown>>(
      `SELECT sg_uf, cd_municipio, nr_zona, nr_secao, secoes_agregadas, ds_cargo, tp_voto, nr_votavel, nm_votavel, qt_votos,
              qt_aptos, qt_comparecimento, to_char(dt_totalizacao, 'YYYY-MM-DD HH24:MI:SS') AS dt_totalizacao
       FROM votos_secao WHERE cd_cargo = 1 ORDER BY ordem`,
    );
    expect(rows[0]).toEqual({
      sg_uf: 'AC',
      cd_municipio: '01066',
      nr_zona: 4,
      nr_secao: 1,
      secoes_agregadas: '101;102',
      ds_cargo: 'Presidente',
      tp_voto: 'nominal',
      nr_votavel: 13,
      nm_votavel: 'TREZE RENOMEADO',
      qt_votos: 120,
      qt_aptos: 300,
      qt_comparecimento: 250,
      dt_totalizacao: '2026-10-25 21:00:00',
    });
    expect(rows.map((r) => [r.tp_voto, r.nm_votavel])).toEqual([
      ['nominal', 'TREZE RENOMEADO'],
      ['nominal', 'VINTE E DOIS'],
      ['branco', null],
      ['nulo', null],
    ]);
    const [governor] = await t.db.query<{ ds_cargo: string; nm_votavel: string | null }>(
      'SELECT ds_cargo, nm_votavel FROM votos_secao WHERE cd_cargo = 3',
    );
    expect(governor).toEqual({ ds_cargo: 'Governador', nm_votavel: null });
  });

  it('labels offices without a known name', async () => {
    const other = result('0006');
    other.report = { ...other.report, results: [{ electionId: 6288, officeCode: 26, eligible: 1, turnout: 1, votes: [{ type: 'nominal', number: 1, votes: 1 }] }] };
    await repo().save([other]);
    const [row] = await t.db.query<{ ds_cargo: string }>('SELECT ds_cargo FROM votos_secao');
    expect(row?.ds_cargo).toBe('Cargo 26');
  });

  it('rolls back the whole batch when one section fails', async () => {
    const bad = result('0008');
    bad.section = { ...bad.section, publishedAt: 'not a date' };
    await expect(repo().save([result('0007'), bad])).rejects.toThrow();
    await expect(repo().loadAll()).resolves.toEqual([]);
  });
});
