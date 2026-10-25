export interface ElectionRef {
  baseUrl: string;
  cycle: string;
  electionCode: number;
}

const pad = (value: number, size: number): string => String(value).padStart(size, '0');

export function municipalityConfigUrl(ref: ElectionRef): string {
  return `${ref.baseUrl}/${ref.cycle}/${ref.electionCode}/config/mun-e${pad(ref.electionCode, 6)}-cm.json`;
}

export function trackingUrl(ref: ElectionRef, state: string): string {
  const uf = state.toLowerCase();
  return `${ref.baseUrl}/${ref.cycle}/${ref.electionCode}/dados/${uf}/${uf}-e${pad(ref.electionCode, 6)}-ab.json`;
}

export function municipalityResultUrl(
  ref: ElectionRef,
  state: string,
  municipalityCode: string,
  officeCode: number,
): string {
  const uf = state.toLowerCase();
  return (
    `${ref.baseUrl}/${ref.cycle}/${ref.electionCode}/dados/${uf}/` +
    `${uf}${municipalityCode}-c${pad(officeCode, 4)}-e${pad(ref.electionCode, 6)}-u.json`
  );
}
