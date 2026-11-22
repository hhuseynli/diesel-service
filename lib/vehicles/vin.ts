// A vehicle is its VIN (spec 00, sections 2 and 3a; R25).
// 17 characters, no I, O or Q. The check digit is not enforced: it is only
// mandatory for North American vehicles (plan 01, flag F7).
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Uppercases and strips whitespace, as scanned or typed VINs often contain spaces. */
export function normalizeVin(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function isValidVin(vin: string): boolean {
  return VIN_PATTERN.test(vin);
}
