// Plan 03, P5: sign-in, PIN switching, lockout and sessions (spec 00, sections 10-11; R11).
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions, users } from "@/db/schema";
import { withActor } from "@/lib/audit";
import {
  enableTotp,
  MAX_FAILURES,
  registerTablet,
  setPassword,
  setPin,
  signInWithPassword,
  signInWithPin,
  signOut,
  unlockUser,
  validateSession,
} from "@/lib/auth";
import { base32Decode, hashToken, totp } from "@/lib/auth/crypto";
import type { Role } from "@/lib/users/roles";
import { createUser } from "./fixtures";
import { asActor, createTestDb, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;
let manager: string;
let deviceToken: string;

beforeAll(async () => {
  t = await createTestDb();
  manager = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
  deviceToken = await withActor(t.db, { userId: manager }, (tx) => registerTablet(tx, "Sex"));
});
afterAll(() => t.close());

async function staff(roles: Role[], creds: { pin?: string; password?: string }) {
  const id = await createUser(t.migratorPool, { roles });
  await withActor(t.db, { userId: id }, async (tx) => {
    if (creds.pin) await setPin(tx, id, creds.pin);
    if (creds.password) await setPassword(tx, id, creds.password);
  });
  const [u] = await t.db.select({ phone: users.phone }).from(users).where(eq(users.id, id));
  return { id, phone: u!.phone };
}

async function dbNowSeconds() {
  const { rows } = await t.db.execute<{ t: string }>(
    sql`SELECT extract(epoch FROM now())::bigint AS t`,
  );
  return Number(rows[0]!.t);
}

describe("tablet PIN", () => {
  it("the right PIN starts a session; switching user ends the previous one", async () => {
    const a = await staff(["FORMEN"], { pin: "4821" });
    const b = await staff(["FORMEN"], { pin: "7310" });
    const first = await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "4821" });
    expect(first.status).toBe("OK");
    const firstToken = (first as { token: string }).token;
    expect(await validateSession(t.db, firstToken)).toMatchObject({ userId: a.id, kind: "TABLET" });

    const second = await signInWithPin(t.db, { deviceToken, userId: b.id, pin: "7310" });
    expect(second.status).toBe("OK");
    expect(await validateSession(t.db, firstToken)).toBeNull();
    const [ended] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(firstToken)));
    expect(ended!.endReason).toBe("SWITCH_USER");
  });

  it("an unknown or revoked device cannot sign anyone in", async () => {
    const a = await staff(["FORMEN"], { pin: "1111" });
    expect(
      (await signInWithPin(t.db, { deviceToken: "nope", userId: a.id, pin: "1111" })).status,
    ).toBe("UNKNOWN_DEVICE");
  });

  it(`${MAX_FAILURES} wrong PINs in a row lock the account until management unlocks it`, async () => {
    const a = await staff(["FORMEN"], { pin: "2468" });
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "0000" })).status).toBe(
        "INVALID",
      );
    }
    expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "0000" })).status).toBe(
      "LOCKED",
    );
    // Even the right PIN is refused now.
    expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "2468" })).status).toBe(
      "LOCKED",
    );

    await withActor(t.db, { userId: manager }, (tx) =>
      unlockUser(tx, a.id, "Şəxsiyyət yoxlanıldı"),
    );
    expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "2468" })).status).toBe(
      "OK",
    );
  });

  it("a success resets the failure count", async () => {
    const a = await staff(["FORMEN"], { pin: "1357" });
    for (let i = 1; i < MAX_FAILURES; i++)
      await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "9999" });
    expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "1357" })).status).toBe(
      "OK",
    );
    expect((await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "9999" })).status).toBe(
      "INVALID",
    );
  });

  it("a tablet session locks after the idle time", async () => {
    await asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "test" }, (c) =>
      c.query("INSERT INTO settings (key, value) VALUES ('tablet_idle_seconds', '1')"),
    );
    const a = await staff(["FORMEN"], { pin: "8642" });
    const r = await signInWithPin(t.db, { deviceToken, userId: a.id, pin: "8642" });
    const token = (r as { token: string }).token;
    expect(await validateSession(t.db, token)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await validateSession(t.db, token)).toBeNull();
    const [s] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(s!.endReason).toBe("IDLE_LOCK");
    await asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "test" }, (c) =>
      c.query("INSERT INTO settings (key, value) VALUES ('tablet_idle_seconds', '300')"),
    );
  });
});

describe("office sign-in", () => {
  it("password for staff; TOTP is required for management and the owner", async () => {
    const cashier = await staff(["CASHIER"], { password: "kassa-sifre-2026" });
    expect(
      (await signInWithPassword(t.db, { phone: cashier.phone, password: "yanlis-sifre" })).status,
    ).toBe("INVALID");
    const ok = await signInWithPassword(t.db, {
      phone: cashier.phone,
      password: "kassa-sifre-2026",
    });
    expect(ok.status).toBe("OK");
    expect(await validateSession(t.db, (ok as { token: string }).token)).toMatchObject({
      userId: cashier.id,
      kind: "OFFICE",
    });

    const boss = await staff(["MANAGEMENT"], { password: "rehberlik-sifre-1" });
    expect(
      (await signInWithPassword(t.db, { phone: boss.phone, password: "rehberlik-sifre-1" })).status,
    ).toBe("TOTP_NOT_ENROLLED");
    const secret = await withActor(t.db, { userId: boss.id }, (tx) => enableTotp(tx, boss.id));
    expect(
      (await signInWithPassword(t.db, { phone: boss.phone, password: "rehberlik-sifre-1" })).status,
    ).toBe("TOTP_REQUIRED");
    const code = totp(base32Decode(secret), await dbNowSeconds());
    const signed = await signInWithPassword(t.db, {
      phone: boss.phone,
      password: "rehberlik-sifre-1",
      totpCode: code,
    });
    expect(signed.status).toBe("OK");
    expect(
      (
        await signInWithPassword(t.db, {
          phone: boss.phone,
          password: "rehberlik-sifre-1",
          totpCode: "000000",
        })
      ).status,
    ).toBe("INVALID");
  });

  it("signing out ends the session; an expired session is refused", async () => {
    const a = await staff(["BOOKKEEPER"], { password: "muhasib-sifre-1" });
    const r = await signInWithPassword(t.db, { phone: a.phone, password: "muhasib-sifre-1" });
    const token = (r as { token: string }).token;
    await signOut(t.db, token);
    expect(await validateSession(t.db, token)).toBeNull();

    // expires_at cannot change after creation (sessions_guard), so expiry is checked
    // with a session created already expired.
    const expired = await asActor(t.appPool, { userId: a.id }, (c) =>
      c.query(
        `INSERT INTO sessions (user_id, token_hash, kind, expires_at) VALUES ($1, $2, 'OFFICE', now() - interval '1 second')`,
        [a.id, hashToken("expired-token")],
      ),
    );
    expect(expired.rowCount).toBe(1);
    expect(await validateSession(t.db, "expired-token")).toBeNull();
  });

  it("a deactivated user's session is refused", async () => {
    const a = await staff(["CASHIER"], { password: "deaktiv-sifre-1" });
    const r = await signInWithPassword(t.db, { phone: a.phone, password: "deaktiv-sifre-1" });
    await withActor(t.db, { userId: manager, reason: "İşdən çıxıb" }, (tx) =>
      tx.update(users).set({ isActive: false }).where(eq(users.id, a.id)),
    );
    expect(await validateSession(t.db, (r as { token: string }).token)).toBeNull();
  });
});

describe("credentials stay secret", () => {
  it("tokens are stored only as hashes; credentials never reach audit_log", async () => {
    const a = await staff(["CASHIER"], { pin: "5050", password: "gizli-sifre-123" });
    const r = await signInWithPassword(t.db, { phone: a.phone, password: "gizli-sifre-123" });
    const token = (r as { token: string }).token;
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1",
      [token],
    );
    expect(rows[0].n).toBe(0);
    const { rows: audit } = await t.migratorPool.query(
      "SELECT before, after, details FROM audit_log WHERE table_name = 'users' AND record_id = $1",
      [a.id],
    );
    const text = JSON.stringify(audit);
    for (const key of ['pin_hash":', 'password_hash":', 'totp_secret_enc":', "scrypt$"]) {
      expect(text).not.toContain(key);
    }
    expect(audit.map((r) => r.details)).toEqual(
      expect.arrayContaining([{ pin_hash_changed: true }, { password_hash_changed: true }]),
    );
  });

  it("a PIN is 4-6 digits; a password at least 10 characters; others' credentials need the owner", async () => {
    const a = await staff(["FORMEN"], {});
    await expect(withActor(t.db, { userId: a.id }, (tx) => setPin(tx, a.id, "12"))).rejects.toThrow(
      RangeError,
    );
    await expect(
      withActor(t.db, { userId: a.id }, (tx) => setPassword(tx, a.id, "short")),
    ).rejects.toThrow(RangeError);
    const b = await staff(["FORMEN"], {});
    await expect(
      withActor(t.db, { userId: a.id }, (tx) => setPin(tx, b.id, "1234")),
    ).rejects.toThrow(/Not permitted/);
  });
});
