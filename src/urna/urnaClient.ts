import type { Section } from '../domain/types.js';
import type { HttpClient } from '../http/httpClient.js';
import { BerError } from './ber.js';
import { decodeBallotBoxReport, type BallotBoxReport } from './bu.js';
import { isRawAuxFile, isRawCandidateFile, isRawSectionList } from './guards.js';
import type { RawSectionList } from './rawTypes.js';
import { auxFileUrl, ballotBoxReportUrl, candidateFileUrl, sectionListUrl, type PleitoRef } from './urls.js';

export type SectionListResponse =
  | { kind: 'updated'; sections: Section[]; etag: string | null }
  | { kind: 'not_modified' }
  | { kind: 'not_found' }
  | { kind: 'invalid' };

export type AuxResponse =
  | { kind: 'ready'; hash: string; fileName: string }
  /** The section has no totalized BU yet (e.g. still being received). */
  | { kind: 'pending' }
  | { kind: 'not_found' }
  | { kind: 'invalid' };

export type ReportResponse = { kind: 'ok'; report: BallotBoxReport } | { kind: 'not_found' } | { kind: 'invalid'; reason: string };

export interface UrnaClient {
  getSectionList(state: string, etag: string | null, signal?: AbortSignal): Promise<SectionListResponse>;
  getAux(section: Section, signal?: AbortSignal): Promise<AuxResponse>;
  getReport(section: Section, hash: string, fileName: string, signal?: AbortSignal): Promise<ReportResponse>;
  /** Candidate number -> ballot name; empty when the office has no file for that state. */
  getCandidateNames(electionId: number, state: string, officeCode: number, signal?: AbortSignal): Promise<Map<number, string>>;
}

export function mapSectionList(raw: RawSectionList): Section[] {
  return raw.abr.flatMap((state) =>
    state.mu.flatMap((m) =>
      m.zon.flatMap((z) =>
        z.sec
          // Aggregated sections have no BU of their own; they are listed on their principal.
          .filter((s) => s.nsp === undefined)
          .map((s) => ({
            state: state.cd.toLowerCase(),
            municipalityCode: m.cd,
            municipalityName: m.nm,
            zone: z.cd,
            section: s.ns,
            aggregated: s.nsa ?? [],
            publishedAt: s.da && s.ha ? `${s.da} ${s.ha}` : null,
          })),
      ),
    ),
  );
}

export function createUrnaClient(http: HttpClient, ref: PleitoRef): UrnaClient {
  return {
    async getSectionList(state, etag, signal) {
      const response = await http.getJson(sectionListUrl(ref, state), { etag, signal });
      if (response.kind !== 'ok') return response;
      if (!isRawSectionList(response.body) || Number(response.body.cdp) !== ref.pleitoCode) return { kind: 'invalid' };
      return { kind: 'updated', sections: mapSectionList(response.body), etag: response.etag };
    },

    async getAux(section, signal) {
      const response = await http.getJson(auxFileUrl(ref, section), { signal });
      if (response.kind === 'not_found') return response;
      if (response.kind !== 'ok' || !isRawAuxFile(response.body)) return { kind: 'invalid' };
      // A section may carry several BUs over time (e.g. a replaced ballot box); the
      // totalized one is what the official result counts.
      const totalized = response.body.hashes.filter((h) => h.st === 'Totalizado');
      const latest = totalized.at(-1);
      const bu = latest?.arq.find((a) => a.tp === 'bu');
      if (!latest || !bu) return { kind: 'pending' };
      return { kind: 'ready', hash: latest.hash, fileName: bu.nm };
    },

    async getReport(section, hash, fileName, signal) {
      const response = await http.getBytes(ballotBoxReportUrl(ref, section, hash, fileName), { signal });
      if (response.kind === 'not_found') return response;
      if (response.kind !== 'ok') return { kind: 'invalid', reason: 'unexpected not_modified' };
      let report: BallotBoxReport;
      try {
        report = decodeBallotBoxReport(response.body);
      } catch (error) {
        if (error instanceof BerError) return { kind: 'invalid', reason: error.message };
        throw error;
      }
      const matches =
        report.municipality === Number(section.municipalityCode) &&
        report.zone === Number(section.zone) &&
        report.section === Number(section.section);
      if (!matches) return { kind: 'invalid', reason: 'BU belongs to a different section' };
      return { kind: 'ok', report };
    },

    async getCandidateNames(electionId, state, officeCode, signal) {
      const url = candidateFileUrl(ref, electionId, state, officeCode);
      const response = await http.getJson(url, { signal });
      if (response.kind === 'not_found') return new Map();
      if (response.kind !== 'ok' || !isRawCandidateFile(response.body)) {
        throw new Error(`candidate file unusable: ${url}`);
      }
      const names = new Map<number, string>();
      for (const office of response.body.carg) {
        for (const agreement of office.agr) {
          for (const party of agreement.par) {
            for (const cand of party.cand ?? []) names.set(Number(cand.n), cand.nmu);
          }
        }
      }
      return names;
    },
  };
}
