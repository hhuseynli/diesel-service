// Exact money and quantity arithmetic (spec 00, section 2).
// Values are integers in minor units held as bigint, so there is no floating
// point anywhere. Database NUMERIC values arrive as strings and go back as strings.

const MONEY_SCALE = 2; // NUMERIC(14,2): qəpik
const QUANTITY_SCALE = 3; // NUMERIC(12,3): thousandths of a unit
const RATE_SCALE = 2; // NUMERIC(5,2): percent with two decimals
const MONEY_MAX = 10n ** 14n; // 12 integer digits + 2 decimals
const QUANTITY_MAX = 10n ** 12n; // 9 integer digits + 3 decimals

function parseDecimal(input: unknown, scale: number, what: string): bigint {
  if (typeof input !== "string") {
    throw new TypeError(`${what} must be a decimal string, got ${typeof input}`);
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new RangeError(`Invalid ${what}: "${input}"`);
  const [, sign, whole, fraction = ""] = m;
  // Trailing zeros beyond the scale are harmless ("12.500" as money); other digits are not.
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > scale) {
    throw new RangeError(`${what} "${input}" has more than ${scale} decimals`);
  }
  const units = BigInt(whole! + trimmed.padEnd(scale, "0"));
  return sign && units !== 0n ? -units : units;
}

function toDecimalString(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Divides and rounds half away from zero (commercial rounding). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

export class Quantity {
  private constructor(readonly milli: bigint) {}

  static parse(input: string): Quantity {
    const milli = parseDecimal(input, QUANTITY_SCALE, "quantity");
    if (milli >= QUANTITY_MAX || milli <= -QUANTITY_MAX) {
      throw new RangeError(`Quantity "${input}" does not fit NUMERIC(12,3)`);
    }
    return new Quantity(milli);
  }

  toDb(): string {
    return toDecimalString(this.milli, QUANTITY_SCALE);
  }

  /** Display form without trailing zeros: "2", "1,5", "1 234,125" (azerbaijani-ui skill). */
  formatAz(): string {
    const [whole, fraction] = this.toDb().split(".") as [string, string];
    const trimmed = fraction.replace(/0+$/, "");
    return `${groupThousands(whole)}${trimmed ? `,${trimmed}` : ""}`;
  }
}

export class Rate {
  private constructor(readonly hundredths: bigint) {}

  /** A percentage such as "18.00". */
  static parse(input: string): Rate {
    const hundredths = parseDecimal(input, RATE_SCALE, "rate");
    if (hundredths < 0n || hundredths > 100_00n) {
      throw new RangeError(`Rate "${input}" must be between 0 and 100`);
    }
    return new Rate(hundredths);
  }

  toDb(): string {
    return toDecimalString(this.hundredths, RATE_SCALE);
  }
}

export class Money {
  private constructor(readonly qepik: bigint) {
    if (qepik >= MONEY_MAX || qepik <= -MONEY_MAX) {
      throw new RangeError("Amount does not fit NUMERIC(14,2)");
    }
  }

  static readonly zero = new Money(0n);

  /** Parses an AZN amount in database form, e.g. "1234.50". */
  static parse(input: string): Money {
    return new Money(parseDecimal(input, MONEY_SCALE, "amount"));
  }

  static fromQepik(qepik: bigint): Money {
    return new Money(qepik);
  }

  toDb(): string {
    return toDecimalString(this.qepik, MONEY_SCALE);
  }

  add(other: Money): Money {
    return new Money(this.qepik + other.qepik);
  }

  sub(other: Money): Money {
    return new Money(this.qepik - other.qepik);
  }

  negate(): Money {
    return new Money(-this.qepik);
  }

  /** Unit price times quantity, rounded half up to the qəpik. */
  mulQty(quantity: Quantity): Money {
    return new Money(divRound(this.qepik * quantity.milli, 10n ** BigInt(QUANTITY_SCALE)));
  }

  /** This amount times a percentage, rounded half up to the qəpik. */
  mulRate(rate: Rate): Money {
    return new Money(divRound(this.qepik * rate.hundredths, 100n * 10n ** BigInt(RATE_SCALE)));
  }

  compare(other: Money): -1 | 0 | 1 {
    return this.qepik < other.qepik ? -1 : this.qepik > other.qepik ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.qepik === other.qepik;
  }

  isZero(): boolean {
    return this.qepik === 0n;
  }

  /** Display form for Azerbaijani screens and documents: "1 234,50" (azerbaijani-ui skill). */
  formatAz(): string {
    const [whole, fraction] = this.toDb().split(".") as [string, string];
    return `${groupThousands(whole)},${fraction}`;
  }
}

/** A whole number with a space between thousands: "-1234567" -> "-1 234 567". */
export function groupThousands(whole: string | number): string {
  const digits = String(whole);
  const negative = digits.startsWith("-");
  const grouped = (negative ? digits.slice(1) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "-" : ""}${grouped}`;
}
