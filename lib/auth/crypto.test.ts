import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashSecret,
  hashToken,
  newTotpSecret,
  totp,
  verifySecret,
  verifyTotp,
} from "./crypto";

describe("hashSecret", () => {
  it("verifies the right secret and refuses a wrong one", () => {
    const stored = hashSecret("4821");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(verifySecret("4821", stored)).toBe(true);
    expect(verifySecret("4822", stored)).toBe(false);
    expect(verifySecret("4821", "garbage")).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashSecret("4821")).not.toBe(hashSecret("4821"));
  });
});

describe("TOTP (RFC 6238 appendix B, SHA-1)", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("T=%i gives %s", (t, expected) => {
    expect(totp(secret, t, 8)).toBe(expected);
  });

  it("accepts the current code and one step of drift, nothing further", () => {
    const b32 = base32Encode(secret);
    const now = 1_800_000_000;
    const code = totp(secret, now);
    expect(verifyTotp(b32, code, now)).toBe(true);
    expect(verifyTotp(b32, code, now + 30)).toBe(true);
    expect(verifyTotp(b32, code, now + 90)).toBe(false);
    expect(verifyTotp(b32, "12345", now)).toBe(false);
  });

  it("round-trips base32", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
  });
});

describe("encryptSecret", () => {
  it("round-trips and detects tampering", () => {
    const stored = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(stored)).toBe("JBSWY3DPEHPK3PXP");
    const [v, iv, tag, data] = stored.split(".");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });
});

describe("hashToken", () => {
  it("is deterministic and does not reveal the token", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});
