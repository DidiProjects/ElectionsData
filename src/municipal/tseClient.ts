import type { Municipality, MunicipalityResult } from './types.js';
import type { HttpClient } from '../http/httpClient.js';
import { isRawMunicipalityConfig, isRawTrackingFile, isValidMunicipalityResult } from './guards.js';
import { mapMunicipalities, mapMunicipalityResult } from './mapper.js';
import { municipalityConfigUrl, municipalityResultUrl, trackingUrl, type ElectionRef } from './urls.js';

/** Fingerprint of a municipality's totalization progress, as published in the state tracking file. */
export type TrackingSnapshot = Map<string, string>;

export type Conditional<T> =
  | { kind: 'updated'; value: T; etag: string | null }
  | { kind: 'not_modified' }
  | { kind: 'not_found' }
  | { kind: 'invalid' };

export interface TseClient {
  getMunicipalities(states: string[], signal?: AbortSignal): Promise<Municipality[]>;
  getTracking(state: string, etag: string | null, signal?: AbortSignal): Promise<Conditional<TrackingSnapshot>>;
  getMunicipalityResult(
    municipality: Municipality,
    officeCode: number,
    etag: string | null,
    signal?: AbortSignal,
  ): Promise<Conditional<MunicipalityResult>>;
}

export function createTseClient(http: HttpClient, ref: ElectionRef): TseClient {
  return {
    async getMunicipalities(states, signal) {
      const url = municipalityConfigUrl(ref);
      const response = await http.getJson(url, { signal });
      if (response.kind !== 'ok') throw new Error(`municipality list unavailable (${response.kind}): ${url}`);
      if (!isRawMunicipalityConfig(response.body)) throw new Error(`municipality list has unexpected shape: ${url}`);
      return mapMunicipalities(response.body, states);
    },

    async getTracking(state, etag, signal) {
      const response = await http.getJson(trackingUrl(ref, state), { etag, signal });
      if (response.kind !== 'ok') return response.kind === 'not_modified' ? { kind: 'not_modified' } : { kind: 'not_found' };
      if (!isRawTrackingFile(response.body) || Number(response.body.ele) !== ref.electionCode) return { kind: 'invalid' };

      const snapshot: TrackingSnapshot = new Map();
      for (const entry of response.body.abr) {
        if (entry.tpabr !== 'mun') continue;
        snapshot.set(entry.cdabr, `${entry.and}|${entry.dt}|${entry.ht}|${entry.s.st}`);
      }
      return { kind: 'updated', value: snapshot, etag: response.etag };
    },

    async getMunicipalityResult(municipality, officeCode, etag, signal) {
      const url = municipalityResultUrl(ref, municipality.state, municipality.code, officeCode);
      const response = await http.getJson(url, { etag, signal });
      if (response.kind === 'not_modified') return { kind: 'not_modified' };
      if (response.kind === 'not_found') return { kind: 'not_found' };
      const expected = { electionCode: ref.electionCode, municipalityCode: municipality.code, officeCode };
      if (!isValidMunicipalityResult(response.body, expected)) return { kind: 'invalid' };
      return {
        kind: 'updated',
        value: mapMunicipalityResult(response.body, municipality, officeCode),
        etag: response.etag,
      };
    },
  };
}
