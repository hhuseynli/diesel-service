import { describe, expect, it } from "vitest";
import { DOC_TYPES } from "@/lib/documents/types";
import { formatNumber } from "./format";
import { PREFIXES } from "./prefixes";

describe("formatNumber", () => {
  it("formats <PREFIX>-<YEAR>-<6 digits>", () => {
    expect(formatNumber("QA", 2026, 123)).toBe("QA-2026-000123");
    expect(formatNumber("ST", 2027, 1)).toBe("ST-2027-000001");
    expect(formatNumber("MX", 2026, 999_999)).toBe("MX-2026-999999");
  });

  it("refuses sequences outside 1..999999", () => {
    expect(() => formatNumber("QA", 2026, 0)).toThrow(RangeError);
    expect(() => formatNumber("QA", 2026, 1_000_000)).toThrow(RangeError);
    expect(() => formatNumber("QA", 2026, 1.5)).toThrow(RangeError);
  });

  it("refuses malformed prefixes and years", () => {
    expect(() => formatNumber("qa", 2026, 1)).toThrow(RangeError);
    expect(() => formatNumber("QA", 26, 1)).toThrow(RangeError);
  });
});

describe("PREFIXES", () => {
  it("gives every document type and job orders a unique two-letter prefix", () => {
    const prefixes = [...DOC_TYPES.map((t) => PREFIXES[t]), PREFIXES.JOB_ORDER];
    expect(new Set(prefixes).size).toBe(DOC_TYPES.length + 1);
    expect(formatNumber(PREFIXES.JOB_ORDER, 2026, 1)).toBe("IS-2026-000001");
    for (const p of prefixes) expect(p).toMatch(/^[A-Z]{2}$/);
  });
});
