export interface PleitoRef {
  baseUrl: string;
  cycle: string;
  pleitoCode: number;
}

export interface SectionAddress {
  state: string;
  municipalityCode: string;
  zone: string;
  section: string;
}

const pad = (value: number, size: number): string => String(value).padStart(size, '0');

const archiveBase = (ref: PleitoRef): string => `${ref.baseUrl}/${ref.cycle}/arquivo-urna/${ref.pleitoCode}`;

const sectionDir = (ref: PleitoRef, s: SectionAddress): string =>
  `${archiveBase(ref)}/dados/${s.state}/${s.municipalityCode}/${s.zone}/${s.section}`;

export function sectionListUrl(ref: PleitoRef, state: string): string {
  const uf = state.toLowerCase();
  return `${archiveBase(ref)}/config/${uf}/${uf}-p${pad(ref.pleitoCode, 6)}-cs.json`;
}

export function auxFileUrl(ref: PleitoRef, s: SectionAddress): string {
  return `${sectionDir(ref, s)}/p${pad(ref.pleitoCode, 6)}-${s.state}-m${s.municipalityCode}-z${s.zone}-s${s.section}-aux.json`;
}

export function ballotBoxReportUrl(ref: PleitoRef, s: SectionAddress, hash: string, fileName: string): string {
  return `${sectionDir(ref, s)}/${hash}/${fileName}`;
}

export function candidateFileUrl(
  ref: { baseUrl: string; cycle: string },
  electionId: number,
  state: string,
  officeCode: number,
): string {
  const uf = state.toLowerCase();
  return `${ref.baseUrl}/${ref.cycle}/${electionId}/dados/${uf}/${uf}-c${pad(officeCode, 4)}-e${pad(electionId, 6)}-u.json`;
}
