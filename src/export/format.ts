const BRASILIA_OFFSET_MS = -3 * 60 * 60 * 1000;

/** "YYYY-MM-DD HH:mm:ss" in Brasília time. Brazil has had no DST since 2019, so the offset is fixed. */
export function formatBrasilia(date: Date): string {
  return new Date(date.getTime() + BRASILIA_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** TSE "dd/mm/yyyy hh:mm:ss" -> "YYYY-MM-DD hh:mm:ss"; anything else is returned unchanged. */
export function formatTseDateTime(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}` : value;
}

/** Ballot box "YYYYMMDDTHHMMSS" -> "YYYY-MM-DD HH:MM:SS"; anything else is returned unchanged. */
export function formatUrnaTimestamp(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : value;
}
