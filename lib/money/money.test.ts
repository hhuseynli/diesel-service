import { describe, expect, it } from "vitest";
import { groupThousands, Money, Quantity, Rate } from "./index";

describe("Money", () => {
  it("round-trips database strings exactly", () => {
    for (const s of ["0.00", "0.01", "12.34", "-5.10", "999999999999.99"]) {
      expect(Money.parse(s).toDb()).toBe(s);
    }
    expect(Money.parse("7").toDb()).toBe("7.00");
    expect(Money.parse("7.5").toDb()).toBe("7.50");
    expect(Money.parse("-0.00").toDb()).toBe("0.00");
  });

  it("adds without floating point error", () => {
    // 0.1 + 0.2 !== 0.3 with numbers.
    expect(Money.parse("0.10").add(Money.parse("0.20")).toDb()).toBe("0.30");
    expect(Money.parse("10.00").sub(Money.parse("10.01")).toDb()).toBe("-0.01");
  });

  it("refuses JS numbers and malformed input", () => {
    expect(() => Money.parse(12.5 as unknown as string)).toThrow(TypeError);
    expect(() => Money.parse("1,50")).toThrow(RangeError);
    expect(() => Money.parse("1.234")).toThrow(RangeError);
    expect(() => Money.parse("abc")).toThrow(RangeError);
  });

  it("accepts trailing zeros beyond the scale", () => {
    expect(Money.parse("12.500").toDb()).toBe("12.50");
  });

  it("refuses amounts that do not fit NUMERIC(14,2)", () => {
    expect(() => Money.parse("1000000000000.00")).toThrow(RangeError);
  });

  it("multiplies by quantity, rounding half up", () => {
    expect(Money.parse("10.00").mulQty(Quantity.parse("1.5")).toDb()).toBe("15.00");
    // 0.33 * 1.5 = 0.495 -> 0.50
    expect(Money.parse("0.33").mulQty(Quantity.parse("1.5")).toDb()).toBe("0.50");
    // 0.33 * 1.499 = 0.49467 -> 0.49
    expect(Money.parse("0.33").mulQty(Quantity.parse("1.499")).toDb()).toBe("0.49");
    // Negative amounts round away from zero: -0.495 -> -0.50
    expect(Money.parse("-0.33").mulQty(Quantity.parse("1.5")).toDb()).toBe("-0.50");
  });

  it("applies a percentage, rounding half up", () => {
    const vat = Rate.parse("18.00");
    expect(Money.parse("100.00").mulRate(vat).toDb()).toBe("18.00");
    // 0.25 * 18% = 0.045 -> 0.05
    expect(Money.parse("0.25").mulRate(vat).toDb()).toBe("0.05");
    // 0.24 * 18% = 0.0432 -> 0.04
    expect(Money.parse("0.24").mulRate(vat).toDb()).toBe("0.04");
  });

  it("compares", () => {
    expect(Money.parse("1.00").compare(Money.parse("2.00"))).toBe(-1);
    expect(Money.parse("2.00").compare(Money.parse("2.00"))).toBe(0);
    expect(Money.parse("2.00").equals(Money.parse("2"))).toBe(true);
    expect(Money.zero.isZero()).toBe(true);
  });

  it("formats for Azerbaijani display", () => {
    expect(Money.parse("1234.50").formatAz()).toBe("1 234,50");
    expect(Money.parse("1234567.05").formatAz()).toBe("1 234 567,05");
    expect(Money.parse("999.00").formatAz()).toBe("999,00");
    expect(Money.parse("-1234.50").formatAz()).toBe("-1 234,50");
    expect(Quantity.parse("2").formatAz()).toBe("2");
    expect(Quantity.parse("1.5").formatAz()).toBe("1,5");
    expect(Quantity.parse("1234.125").formatAz()).toBe("1 234,125");
    expect(groupThousands(120000)).toBe("120 000");
    expect(groupThousands(999)).toBe("999");
  });
});

describe("Quantity and Rate", () => {
  it("parse within their scale", () => {
    expect(Quantity.parse("2.125").toDb()).toBe("2.125");
    expect(() => Quantity.parse("2.1255")).toThrow(RangeError);
    expect(Rate.parse("18").toDb()).toBe("18.00");
    expect(() => Rate.parse("101")).toThrow(RangeError);
    expect(() => Rate.parse("-1")).toThrow(RangeError);
  });
});
