// Plan 03, P5 (review fixes): who may sign in how, tablet sessions bound to their device,
// the lock computed from attempts and safe against bursts, unlocks, AC5.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contragents, loginAttempts, sessions, tabletDevices, users } from "@/db/schema";
import { withActor } from "@/lib/audit";
import {
  enableTotp,
  isLocked,
  MAX_FAILURES,
  NotSignedInError,
  pinCandidates,
  registerTablet,
  revokeTablet,
  setPassword,
  setPin,
  signInWithPassword,
  signInWithPin,
  signOut,
  unlockUser,
  validateSession,
  withSessionUser,
  type SignInResult,
} from "@/lib/auth";
import { hashToken } from "@/lib/auth/crypto";
import { PermissionError } from "@/lib/permissions";
import type { Role } from "@/lib/users/roles";
import { createUser } from "./fixtures";
import { asActor, createTestDb, sqlstateOf, type TestDb } from "./helpers";

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

const tokenOf = (r: SignInResult): string => {
  if (r.status !== "OK") throw new Error(`Sign-in failed: ${r.status}`);
  return r.token;
};

describe("who signs in how", () => {
  it("management and the owner never sign in by PIN, and are not offered on the tablet", async () => {
    for (const role of ["MANAGEMENT", "OWNER"] as Role[]) {
      const boss = await staff([role, "FORMEN"], { pin: "5555" });
      expect(
        (await signInWithPin(t.db, { deviceToken, userId: boss.id, pin: "5555" })).status,
      ).toBe("NOT_ALLOWED");
      expect((await pinCandidates(t.db)).map((c) => c.id)).not.toContain(boss.id);
    }
  });

  it("mechanics have no login yet (R3)", async () => {
    const mechanic = await staff(["MECHANIC"], { pin: "6666", password: "temirci-sifre-1" });
    expect(
      (await signInWithPassword(t.db, { phone: mechanic.phone, password: "temirci-sifre-1" }))
        .status,
    ).toBe("NOT_ALLOWED");
    expect(
      (await signInWithPin(t.db, { deviceToken, userId: mechanic.id, pin: "6666" })).status,
    ).toBe("NOT_ALLOWED");
  });

  it("an office sign-in on a registered tablet becomes a tablet session", async () => {
    const cashier = await staff(["CASHIER"], { password: "kassa-planset-1" });
    const r = await signInWithPassword(t.db, {
      phone: cashier.phone,
      password: "kassa-planset-1",
      deviceToken,
    });
    expect(await validateSession(t.db, tokenOf(r), deviceToken)).toMatchObject({ kind: "TABLET" });
  });
});

describe("tablet sessions are bound to their tablet", () => {
  it("are refused from another browser, and end when the tablet is revoked", async () => {
    const formen = await staff(["FORMEN"], { pin: "7777" });
    const other = await withActor(t.db, { userId: manager }, (tx) => registerTablet(tx, "İkinci"));
    const r = await signInWithPin(t.db, { deviceToken: other, userId: formen.id, pin: "7777" });
    expect(await validateSession(t.db, tokenOf(r), undefined)).toBeNull();

    const r2 = await signInWithPin(t.db, { deviceToken: other, userId: formen.id, pin: "7777" });
    expect(await validateSession(t.db, tokenOf(r2), other)).not.toBeNull();
    const [device] = await t.db
      .select({ id: tabletDevices.id })
      .from(tabletDevices)
      .where(eq(tabletDevices.tokenHash, hashToken(other)));
    await withActor(t.db, { userId: manager }, (tx) => revokeTablet(tx, device!.id));
    expect(await validateSession(t.db, tokenOf(r2), other)).toBeNull();
    expect(
      (await signInWithPin(t.db, { deviceToken: other, userId: formen.id, pin: "7777" })).status,
    ).toBe("UNKNOWN_DEVICE");
  });

  it("device tokens are stored only as hashes", async () => {
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM tablet_devices WHERE token_hash = $1",
      [deviceToken],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("the lock", () => {
  it("wrong passwords and wrong TOTP codes count; a sign-out does not reset the count", async () => {
    const boss = await staff(["MANAGEMENT"], { password: "rehber-kilid-1" });
    await withActor(t.db, { userId: boss.id }, (tx) => enableTotp(tx, boss.id));
    const signIn = (password: string, totpCode?: string) =>
      signInWithPassword(t.db, { phone: boss.phone, password, totpCode });
    for (let i = 0; i < 2; i++) expect((await signIn("yanlis-sifre-x")).status).toBe("INVALID");
    for (let i = 0; i < 2; i++)
      expect((await signIn("rehber-kilid-1", "000000")).status).toBe("INVALID");
    const kinds = await t.db
      .select({ kind: loginAttempts.kind })
      .from(loginAttempts)
      .where(eq(loginAttempts.userId, boss.id));
    expect(kinds.map((k) => k.kind).sort()).toEqual(["PASSWORD", "PASSWORD", "TOTP", "TOTP"]);

    // A sign-out elsewhere is not a successful credential check.
    const cashier = await staff(["CASHIER"], { password: "kassa-kilid-12" });
    const s = await signInWithPassword(t.db, { phone: cashier.phone, password: "kassa-kilid-12" });
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await signInWithPassword(t.db, { phone: cashier.phone, password: "yanlis-sifre-x" });
    }
    await signOut(t.db, tokenOf(s));
    expect(
      (await signInWithPassword(t.db, { phone: cashier.phone, password: "yanlis-sifre-x" })).status,
    ).toBe("LOCKED");
  });

  it("a burst of parallel wrong PINs records no more than the limit; the account locks", async () => {
    const formen = await staff(["FORMEN"], { pin: "2580" });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        signInWithPin(t.db, { deviceToken, userId: formen.id, pin: "0000" }),
      ),
    );
    expect(results.filter((r) => r.status === "INVALID")).toHaveLength(MAX_FAILURES - 1);
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM login_attempts WHERE user_id = $1 AND NOT success",
      [formen.id],
    );
    expect(rows[0].n).toBe(MAX_FAILURES);
    expect(
      (await signInWithPin(t.db, { deviceToken, userId: formen.id, pin: "2580" })).status,
    ).toBe("LOCKED");
    expect((await pinCandidates(t.db)).map((c) => c.id)).not.toContain(formen.id);
  });

  it("locking ends the user's open sessions", async () => {
    const cashier = await staff(["CASHIER"], { password: "kassa-sessiya-1" });
    const s = await signInWithPassword(t.db, { phone: cashier.phone, password: "kassa-sessiya-1" });
    for (let i = 0; i < MAX_FAILURES; i++) {
      await signInWithPassword(t.db, { phone: cashier.phone, password: "yanlis-sifre-x" });
    }
    expect(await validateSession(t.db, tokenOf(s))).toBeNull();
    const [row] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(tokenOf(s))));
    expect(row!.endReason).toBe("USER_LOCKED");
  });

  it("only management unlocks, with a reason, recorded under their name", async () => {
    const formen = await staff(["FORMEN"], { pin: "1470" });
    for (let i = 0; i < MAX_FAILURES; i++) {
      await signInWithPin(t.db, { deviceToken, userId: formen.id, pin: "0000" });
    }
    expect(await isLocked(t.db, formen.id)).toBe(true);
    const cashier = await staff(["CASHIER"], {});
    await expect(
      withActor(t.db, { userId: cashier.id }, (tx) => unlockUser(tx, formen.id, "x")),
    ).rejects.toBeInstanceOf(PermissionError);
    await expect(
      withActor(t.db, { userId: manager }, (tx) => unlockUser(tx, formen.id, " ")),
    ).rejects.toThrow(/reason/);
    // The database refuses an unlock recorded for someone else.
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId: cashier.id }, (c) =>
          c.query(
            "INSERT INTO login_attempts (user_id, kind, success, recorded_by, reason) VALUES ($1, 'UNLOCK', true, $2, 'x')",
            [formen.id, manager],
          ),
        ),
      ),
    ).toBe("DM007");
    await withActor(t.db, { userId: manager }, (tx) =>
      unlockUser(tx, formen.id, "Şəxsən yoxlanıldı"),
    );
    const [unlock] = await t.db
      .select()
      .from(loginAttempts)
      .where(sql`${loginAttempts.userId} = ${formen.id} AND ${loginAttempts.kind} = 'UNLOCK'`);
    expect(unlock).toMatchObject({ recordedBy: manager, reason: "Şəxsən yoxlanıldı" });
    expect(
      (await signInWithPin(t.db, { deviceToken, userId: formen.id, pin: "1470" })).status,
    ).toBe("OK");
  });
});

describe("sessions and AC5", () => {
  it("a session cannot be moved, extended or revived", async () => {
    const cashier = await staff(["CASHIER"], { password: "kassa-sessiya-2" });
    const other = await staff(["CASHIER"], {});
    const s = await signInWithPassword(t.db, { phone: cashier.phone, password: "kassa-sessiya-2" });
    const where = hashToken(tokenOf(s));
    for (const change of [
      "UPDATE sessions SET user_id = $2 WHERE token_hash = $1",
      "UPDATE sessions SET expires_at = now() + interval '30 days' WHERE token_hash = $1",
    ]) {
      expect(
        await sqlstateOf(
          asActor(t.appPool, { userId: cashier.id }, (c) =>
            c.query(change, change.includes("$2") ? [where, other.id] : [where]),
          ),
        ),
        change,
      ).toBe("DM005");
    }
    await signOut(t.db, tokenOf(s));
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId: cashier.id }, (c) =>
          c.query("UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE token_hash = $1", [
            where,
          ]),
        ),
      ),
    ).toBe("DM005");
  });

  it("a write through a session is attributed to the session's user; no session, no write", async () => {
    const formen = await staff(["FORMEN"], { pin: "3690" });
    const r = await signInWithPin(t.db, { deviceToken, userId: formen.id, pin: "3690" });
    const [row] = await withSessionUser(t.db, { token: tokenOf(r), deviceToken }, (tx) =>
      tx
        .insert(contragents)
        .values({ kind: "FIZIKI", name: "AC5 Müştəri", isCustomer: true })
        .returning({ id: contragents.id, createdBy: contragents.createdBy }),
    );
    expect(row!.createdBy).toBe(formen.id);
    const { rows } = await t.migratorPool.query(
      "SELECT user_id FROM audit_log WHERE table_name = 'contragents' AND record_id = $1",
      [row!.id],
    );
    expect(rows).toEqual([{ user_id: formen.id }]);

    for (const session of [{ token: undefined }, { token: "nonsense" }, { token: tokenOf(r) }]) {
      await expect(
        withSessionUser(t.db, session, (tx) =>
          tx.insert(contragents).values({ kind: "FIZIKI", name: "X", isCustomer: true }),
        ),
      ).rejects.toBeInstanceOf(NotSignedInError);
    }
  });

  it("a refused permission is logged as DENIED", async () => {
    const cashier = await staff(["CASHIER"], {});
    await expect(
      withActor(t.db, { userId: cashier.id }, (tx) => registerTablet(tx, "Gizli")),
    ).rejects.toBeInstanceOf(PermissionError);
    const { rows } = await t.migratorPool.query(
      "SELECT details FROM audit_log WHERE action = 'DENIED' AND user_id = $1",
      [cashier.id],
    );
    expect(rows[0].details).toMatchObject({ operation: "PermissionError", sqlstate: "PERMISSION" });
  });

  it("an enrolled TOTP secret never reaches audit_log", async () => {
    const boss = await staff(["MANAGEMENT"], {});
    const secret = await withActor(t.db, { userId: boss.id }, (tx) => enableTotp(tx, boss.id));
    const { rows } = await t.migratorPool.query(
      "SELECT before, after, details FROM audit_log WHERE table_name = 'users' AND record_id = $1",
      [boss.id],
    );
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain('totp_secret_enc":');
    expect(rows.map((r) => r.details)).toContainEqual({ totp_secret_changed: true });
  });
});
