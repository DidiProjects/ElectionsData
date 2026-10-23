import type {
  CandidateResult,
  Municipality,
  MunicipalityResult,
  TotalizationStatus,
} from '../domain/types.js';
import type { RawMunicipalityConfig, RawMunicipalityResult } from './rawTypes.js';

/** TSE percentages use a decimal comma ("42,130670459"). */
export function parsePercent(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toTotalizationStatus(and: string): TotalizationStatus {
  switch (and.toLowerCase()) {
    case 'f':
      return 'finished';
    case 'n':
      return 'not_started';
    default:
      return 'in_progress';
  }
}

export function mapMunicipalities(raw: RawMunicipalityConfig, states: string[]): Municipality[] {
  const wanted = new Set(states.map((s) => s.toLowerCase()));
  return raw.abr
    .filter((state) => wanted.size === 0 || wanted.has(state.cd.toLowerCase()))
    .flatMap((state) =>
      state.mu.map((m) => ({
        state: state.cd.toLowerCase(),
        code: m.cd,
        ibgeCode: m.cdi,
        name: m.nm,
      })),
    );
}

export function mapMunicipalityResult(
  raw: RawMunicipalityResult,
  municipality: Municipality,
  officeCode: number,
): MunicipalityResult {
  const office = raw.carg.find((o) => Number(o.cd) === officeCode);
  if (!office) throw new Error(`office ${officeCode} missing from result for ${municipality.state}${municipality.code}`);

  const candidates: CandidateResult[] = office.agr.flatMap((agreement) =>
    agreement.par.flatMap((party) =>
      (party.cand ?? []).map((cand) => ({
        number: cand.n,
        name: cand.nm,
        ballotName: cand.nmu,
        party: party.sg,
        coalition: agreement.com ?? '',
        votes: Number(cand.vap),
        votesPct: parsePercent(cand.pvapn ?? cand.pvap),
        status: cand.st ?? '',
        // TSE flags `e: "s"` for runoff qualifiers too; only the status text tells them apart.
        elected: /^eleit[oa]/i.test(cand.st ?? ''),
      })),
    ),
  );
  candidates.sort((a, b) => b.votes - a.votes || a.number.localeCompare(b.number));

  const total = Number(raw.s.ts);
  const counted = Number(raw.s.st);

  return {
    electionCode: Number(raw.ele),
    round: Number(raw.t),
    officeCode,
    officeName: office.nmn,
    municipality,
    generationId: Number(raw.idg),
    generatedAt: `${raw.dg} ${raw.hg}`,
    totalizationStatus: toTotalizationStatus(raw.and),
    totalizationDate: raw.dt,
    totalizationTime: raw.ht,
    sections: {
      total,
      counted,
      countedPct: raw.s.pstn !== undefined ? parsePercent(raw.s.pstn) : total > 0 ? (counted / total) * 100 : 0,
    },
    votes: {
      electorate: Number(raw.e.te),
      turnout: Number(raw.e.c),
      abstention: Number(raw.e.a),
      valid: Number(raw.v.vv),
      blank: Number(raw.v.vb),
      null: Number(raw.v.tvn),
    },
    candidates,
  };
}
