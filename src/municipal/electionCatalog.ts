import type { HttpClient } from '../http/httpClient.js';

export interface PleitoElection {
  electionCode: number;
  /** Configured offices voted in this election. */
  officeCodes: number[];
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is UnknownRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Municipality results are published per election, while the worker is configured per
 * pleito: e.g. 3221 holds president (6258), governor (6260) and supplementary mayor races.
 * The TSE's own election list says which election carries each office.
 */
export async function loadPleitoElections(
  http: HttpClient,
  ref: { baseUrl: string; pleitoCode: number; officeCodes: number[] },
  signal?: AbortSignal,
): Promise<PleitoElection[]> {
  const url = `${ref.baseUrl}/comum/config/ele-c.json`;
  const response = await http.getJson(url, { signal });
  if (response.kind !== 'ok' || !isRecord(response.body)) throw new Error(`election list unavailable: ${url}`);
  const pleito = asArray(response.body.pl).find((p) => isRecord(p) && Number(p.cd) === ref.pleitoCode);
  if (!isRecord(pleito)) throw new Error(`pleito ${ref.pleitoCode} not found in ${url}`);

  const wanted = new Set(ref.officeCodes);
  const elections: PleitoElection[] = [];
  for (const election of asArray(pleito.e)) {
    if (!isRecord(election)) continue;
    const offices = new Set<number>();
    for (const abr of asArray(election.abr)) {
      for (const cp of asArray(isRecord(abr) ? abr.cp : undefined)) {
        const code = Number(isRecord(cp) ? cp.cd : NaN);
        if (wanted.has(code)) offices.add(code);
      }
    }
    if (offices.size > 0) elections.push({ electionCode: Number(election.cd), officeCodes: [...offices].sort((a, b) => a - b) });
  }
  return elections.sort((a, b) => a.electionCode - b.electionCode);
}
