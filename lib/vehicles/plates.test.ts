import { describe, expect, it } from "vitest";
import { normalizePlate } from "./plates";

describe("normalizePlate", () => {
  it("uppercases and removes spaces and hyphens", () => {
    expect(normalizePlate("90-JG-526")).toBe("90JG526");
    expect(normalizePlate("90 jg 526")).toBe("90JG526");
    expect(normalizePlate(" 90-jg 526\t")).toBe("90JG526");
  });

  it("keeps other characters of foreign plates", () => {
    expect(normalizePlate("а123вс 77")).toBe("А123ВС77");
    expect(normalizePlate("AB.123")).toBe("AB.123");
  });
});
