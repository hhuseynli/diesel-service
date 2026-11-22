import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// Credential primitives (plan 03, A6). Node's crypto only; no extra dependency.

// Development only: tests and `pnpm dev` work without AUTH_SECRET (plan 03, A10).
const DEV_SECRET = "diesel-service-development-secret-not-for-production";

/**
 * AUTH_SECRET: at least 32 random bytes, base64 (plan 03, A10). It keys the pepper, the
 * token hashes and the TOTP encryption, so changing it invalidates every PIN, password,
 * session, tablet registration and TOTP enrolment.
 */
export function authSecret(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
    return Buffer.from(DEV_SECRET, "utf8");
  }
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length < 32) throw new Error("AUTH_SECRET must be at least 32 bytes, base64-encoded");
  return bytes;
}

function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret(), Buffer.alloc(0), purpose, 32));
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/**
 * Hashes a PIN or password: HMAC with the server pepper, then scrypt with a random salt.
 * Without the server secret a stolen hash of a 4-6 digit PIN cannot be brute forced.
 */
export function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const peppered = createHmac("sha256", derivedKey("pepper")).update(plain, "utf8").digest();
  const hash = scryptSync(peppered, salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifySecret(plain: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const peppered = createHmac("sha256", derivedKey("pepper")).update(plain, "utf8").digest();
  const actual = scryptSync(peppered, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** SHA-256 of a session or device token; only the hash is stored (plan 03, A8). */
export function hashToken(token: string): string {
  return createHmac("sha256", derivedKey("token")).update(token, "utf8").digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// --- TOTP (RFC 6238) -------------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new RangeError(`Invalid base32 character "${ch}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new TOTP secret, base32 for authenticator apps. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The TOTP code for a time (seconds since the epoch). */
export function totp(secret: Buffer, atSeconds: number, digits = 6, stepSeconds = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atSeconds / stepSeconds)));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Accepts the current code and one step either side, for clock drift. */
export function verifyTotp(secretBase32: string, code: string, atSeconds: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  return [-30, 0, 30].some((drift) => {
    const expected = Buffer.from(totp(secret, atSeconds + drift));
    return timingSafeEqual(expected, Buffer.from(code));
  });
}

// --- Encrypting TOTP secrets at rest (AES-256-GCM) --------------------------------

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey("totp-secret"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Unknown secret format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derivedKey("totp-secret"),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
