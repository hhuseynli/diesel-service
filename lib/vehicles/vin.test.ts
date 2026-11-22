import { describe, expect, it } from "vitest";
import { isValidVin, normalizeVin } from "./vin";

describe("VIN", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeVin(" wdb 9634031l123456 ")).toBe("WDB9634031L123456");
  });

  it("accepts 17 characters without I, O or Q", () => {
    expect(isValidVin("WDB9634031L123456")).toBe(true);
    expect(isValidVin("XTC65115RE1234567")).toBe(true);
  });

  it("rejects wrong length and the letters I, O, Q", () => {
    expect(isValidVin("WDB9634031L12345")).toBe(false);
    expect(isValidVin("WDB9634031L1234567")).toBe(false);
    expect(isValidVin("WDB9634031I123456")).toBe(false);
    expect(isValidVin("WDB9634031O123456")).toBe(false);
    expect(isValidVin("WDB9634031Q123456")).toBe(false);
    expect(isValidVin("wdb9634031l123456")).toBe(false);
  });
});
