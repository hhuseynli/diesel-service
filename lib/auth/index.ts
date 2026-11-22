import { and, eq, isNull, sql } from "drizzle-orm";
import { loginAttempts, sessions, tabletDevices, users } from "@/db/schema";
import { withActor, withReason } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db/types";
import { requirePermission } from "@/lib/permissions";
import {
  decryptSecret,
  encryptSecret,
  hashSecret,
  hashToken,
  newToken,
  newTotpSecret,
  verifySecret,
  verifyTotp,
} from "./crypto";

// Accounts, sign-in and the shared tablet (spec 00, sections 10 and 11; plan 03, A6-A9).
// Every person has their own account (R11). Office: phone + password, plus a TOTP code
// for management and the owner. Tablet: a registered device, then a personal PIN; the
// session locks after the idle time in the `tablet_idle_seconds` setting (default 300).

export const MAX_FAILURES = 5;
const OFFICE_SESSION_HOURS = 12;
const TABLET_SESSION_HOURS = 12;
const DEFAULT_IDLE_SECONDS = 300;
const TOTP_ROLES = ["MANAGEMENT", "OWNER"];

export type SignInResult =
  | { status: "OK"; token: string; userId: string }
  | { status: "INVALID" | "LOCKED" | "TOTP_REQUIRED" | "TOTP_NOT_ENROLLED" | "UNKNOWN_DEVICE" };

// --- Setting credentials ---------------------------------------------------------

async function requireSelfOrAdmin(tx: Tx, userId: string) {
  const { rows } = await tx.execute<{ actor: string }>(sql`SELECT current_actor() AS actor`);
  if (rows[0]!.actor !== userId) await requirePermission(tx, "MANAGE_USERS");
}

/** A 4-6 digit PIN for the shared tablet. The user's own, or set by the owner. */
export async function setPin(tx: Tx, userId: string, pin: string): Promise<void> {
  if (!/^\d{4,6}$/.test(pin)) throw new RangeError("A PIN is 4 to 6 digits");
  await requireSelfOrAdmin(tx, userId);
  await withReason(tx, "audit.pinSet", () =>
    tx
      .update(users)
      .set({ pinHash: hashSecret(pin) })
      .where(eq(users.id, userId)),
  );
}

export async function setPassword(tx: Tx, userId: string, password: string): Promise<void> {
  if (password.length < 10) throw new RangeError("A password is at least 10 characters");
  await requireSelfOrAdmin(tx, userId);
  await withReason(tx, "audit.passwordSet", () =>
    tx
      .update(users)
      .set({ passwordHash: hashSecret(password) })
      .where(eq(users.id, userId)),
  );
}

/** Enrols a TOTP authenticator; returns the base32 secret to show once as a QR code. */
export async function enableTotp(tx: Tx, userId: string): Promise<string> {
  await requireSelfOrAdmin(tx, userId);
  const secret = newTotpSecret();
  await withReason(tx, "audit.totpEnabled", () =>
    tx
      .update(users)
      .set({ totpSecretEnc: encryptSecret(secret) })
      .where(eq(users.id, userId)),
  );
  return secret;
}

/** Lifts a lock after repeated wrong PINs or passwords (management or owner). */
export async function unlockUser(tx: Tx, userId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Unlocking needs a reason");
  await requirePermission(tx, "UNLOCK_USER");
  await withReason(tx, reason, () =>
    tx.update(users).set({ lockedAt: null, lockReason: null }).where(eq(users.id, userId)),
  );
  await tx.insert(loginAttempts).values({ userId, kind: "UNLOCK", success: true });
}

// --- Sign-in ----------------------------------------------------------------------

async function failuresSinceLastSuccess(db: Db, userId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM login_attempts a
     WHERE a.user_id = ${userId} AND NOT a.success
       AND a.at > coalesce((SELECT max(b.at) FROM login_attempts b
                             WHERE b.user_id = ${userId} AND b.success), '-infinity')`);
  return rows[0]!.n;
}

/** Records a failed attempt; the fifth in a row locks the account (plan 03, A7). */
async function recordFailure(
  db: Db,
  userId: string,
  kind: "PIN" | "PASSWORD" | "TOTP",
  deviceId?: string,
): Promise<"INVALID" | "LOCKED"> {
  await db.insert(loginAttempts).values({ userId, kind, success: false, deviceId });
  if ((await failuresSinceLastSuccess(db, userId)) < MAX_FAILURES) return "INVALID";
  await withActor(db, { userId, reason: "audit.lockedAfterFailures" }, (tx) =>
    tx
      .update(users)
      .set({ lockedAt: sql`now()`, lockReason: `${MAX_FAILURES} wrong attempts in a row` })
      .where(and(eq(users.id, userId), isNull(users.lockedAt))),
  );
  return "LOCKED";
}

async function startSession(
  db: Db,
  userId: string,
  kind: "OFFICE" | "TABLET",
  deviceId?: string,
): Promise<string> {
  const token = newToken();
  const hours = kind === "OFFICE" ? OFFICE_SESSION_HOURS : TABLET_SESSION_HOURS;
  await withActor(db, { userId }, async (tx) => {
    if (deviceId) {
      // Switching user on the tablet ends whoever was signed in there.
      await tx
        .update(sessions)
        .set({ endedAt: sql`now()`, endReason: "SWITCH_USER" })
        .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.endedAt)));
    }
    await tx.insert(sessions).values({
      userId,
      tokenHash: hashToken(token),
      kind,
      deviceId,
      expiresAt: sql`now() + make_interval(hours => ${hours})`,
    });
    await tx.insert(loginAttempts).values({
      userId,
      kind: kind === "OFFICE" ? "PASSWORD" : "PIN",
      success: true,
      deviceId,
    });
  });
  return token;
}

async function activeUser(db: Db, where: ReturnType<typeof eq>) {
  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      pinHash: users.pinHash,
      totpSecretEnc: users.totpSecretEnc,
      lockedAt: users.lockedAt,
      isActive: users.isActive,
    })
    .from(users)
    .where(where);
  return user && user.isActive ? user : undefined;
}

async function rolesOf(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.execute<{ role: string }>(
    sql`SELECT role FROM user_roles WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );
  return rows.map((r) => r.role);
}

/** Office sign-in: phone and password, then a TOTP code for management and the owner. */
export async function signInWithPassword(
  db: Db,
  input: { phone: string; password: string; totpCode?: string },
): Promise<SignInResult> {
  const user = await activeUser(db, eq(users.phone, input.phone.trim()));
  if (!user?.passwordHash) {
    await db.insert(loginAttempts).values({ kind: "PASSWORD", success: false });
    return { status: "INVALID" };
  }
  if (user.lockedAt) return { status: "LOCKED" };
  if (!verifySecret(input.password, user.passwordHash)) {
    return { status: await recordFailure(db, user.id, "PASSWORD") };
  }

  const roles = await rolesOf(db, user.id);
  if (roles.some((r) => TOTP_ROLES.includes(r))) {
    if (!user.totpSecretEnc) return { status: "TOTP_NOT_ENROLLED" };
    if (!input.totpCode) return { status: "TOTP_REQUIRED" };
    const { rows } = await db.execute<{ t: number }>(
      sql`SELECT extract(epoch FROM now())::bigint AS t`,
    );
    if (!verifyTotp(decryptSecret(user.totpSecretEnc), input.totpCode, Number(rows[0]!.t))) {
      return { status: await recordFailure(db, user.id, "TOTP") };
    }
  }
  return { status: "OK", userId: user.id, token: await startSession(db, user.id, "OFFICE") };
}

/** Tablet: switch in with a personal PIN on a registered device (spec 01, section 1). */
export async function signInWithPin(
  db: Db,
  input: { deviceToken: string; userId: string; pin: string },
): Promise<SignInResult> {
  const [device] = await db
    .select({ id: tabletDevices.id })
    .from(tabletDevices)
    .where(
      and(
        eq(tabletDevices.tokenHash, hashToken(input.deviceToken)),
        isNull(tabletDevices.revokedAt),
      ),
    );
  if (!device) return { status: "UNKNOWN_DEVICE" };
  const user = await activeUser(db, eq(users.id, input.userId));
  if (!user?.pinHash) {
    await db.insert(loginAttempts).values({ kind: "PIN", success: false, deviceId: device.id });
    return { status: "INVALID" };
  }
  if (user.lockedAt) return { status: "LOCKED" };
  if (!verifySecret(input.pin, user.pinHash)) {
    return { status: await recordFailure(db, user.id, "PIN", device.id) };
  }
  return {
    status: "OK",
    userId: user.id,
    token: await startSession(db, user.id, "TABLET", device.id),
  };
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  kind: "OFFICE" | "TABLET";
}

/**
 * The signed-in user for a session token, or null. Ended, expired, idle (tablet),
 * deactivated or locked sessions are ended here and refused (R11).
 */
export async function validateSession(db: Db, token: string): Promise<SessionUser | null> {
  const { rows } = await db.execute<{
    id: string;
    user_id: string;
    kind: "OFFICE" | "TABLET";
    expired: boolean;
    idle: boolean;
    usable: boolean;
  }>(sql`
    SELECT s.id, s.user_id, s.kind,
           s.expires_at <= now() AS expired,
           (s.kind = 'TABLET' AND now() - s.last_seen_at >
              make_interval(secs => coalesce((
                SELECT (value #>> '{}')::int FROM settings
                 WHERE key = 'tablet_idle_seconds' AND effective_from <= now()
                 ORDER BY effective_from DESC LIMIT 1), ${DEFAULT_IDLE_SECONDS}))) AS idle,
           (u.is_active AND u.locked_at IS NULL) AS usable
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ${hashToken(token)} AND s.ended_at IS NULL`);
  const s = rows[0];
  if (!s) return null;
  const endReason = s.expired
    ? "EXPIRED"
    : s.idle
      ? "IDLE_LOCK"
      : !s.usable
        ? "USER_BLOCKED"
        : null;
  const touch = withActor(db, { userId: s.user_id }, (tx) =>
    tx
      .update(sessions)
      .set(endReason ? { endedAt: sql`now()`, endReason } : { lastSeenAt: sql`now()` })
      .where(eq(sessions.id, s.id)),
  );
  // A deactivated user cannot act, so their session cannot be ended in their name;
  // it is refused here every time instead.
  if (endReason === "USER_BLOCKED") await touch.catch(() => undefined);
  else await touch;
  return endReason ? null : { sessionId: s.id, userId: s.user_id, kind: s.kind };
}

export async function signOut(db: Db, token: string): Promise<void> {
  const [s] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.endedAt)));
  if (!s) return;
  await withActor(db, { userId: s.userId }, async (tx) => {
    await tx
      .update(sessions)
      .set({ endedAt: sql`now()`, endReason: "SIGN_OUT" })
      .where(eq(sessions.id, s.id));
    await tx.insert(loginAttempts).values({ userId: s.userId, kind: "SIGN_OUT", success: true });
  });
}

/** Registers a shared tablet; returns the device token for its long-lived cookie. */
export async function registerTablet(tx: Tx, name: string): Promise<string> {
  await requirePermission(tx, "REGISTER_TABLET");
  const token = newToken();
  await tx.insert(tabletDevices).values({ name: name.trim(), tokenHash: hashToken(token) });
  return token;
}
