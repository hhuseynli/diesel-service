export const MAX_SEQUENCE = 999_999;

/** `<PREFIX>-<YEAR>-<6 digits>`, e.g. QA-2026-000123 (spec 00, section 7). */
export function formatNumber(prefix: string, year: number, sequence: number): string {
  if (!/^[A-Z]{2}$/.test(prefix)) throw new RangeError(`Invalid prefix "${prefix}"`);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`Invalid year ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new RangeError(`Sequence ${sequence} is outside 1..${MAX_SEQUENCE}`);
  }
  return `${prefix}-${year}-${String(sequence).padStart(6, "0")}`;
}
