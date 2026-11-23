import { and, eq, isNull, sql } from "drizzle-orm";
import { loginAttempts, sessions, tabletDevices, users } from "@/db/schema";
import { withActor, withReason } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db/types";
import { requirePermission } from "@/lib/permissions";
import type { Role } from "@/lib/users/roles";
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

/** Roles whose accounts need the second factor, so never sign in with a PIN alone. */
const TOTP_ROLES: Role[] = ["MANAGEMENT", "OWNER"];
/** Roles that may sign in at all; mechanics have no login yet (R3). */
const SIGN_IN_ROLES: Role[] = [
  "OWNER",
  "MANAGEMENT",
  "FORMEN",
  "WAREHOUSEMAN",
  "CASHIER",
  "BOOKKEEPER",
];
/** Attempt kinds that count towards (and reset) a lock. */
type CredentialKind = "PIN" | "PASSWORD" | "TOTP";

export type SignInStatus =
  "INVALID" | "LOCKED" | "TOTP_REQUIRED" | "TOTP_NOT_ENROLLED" | "UNKNOWN_DEVICE" | "NOT_ALLOWED";
export type SignInResult =
  { status: "OK"; token: string; userId: string } | { status: SignInStatus };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let dummy: string | undefined;
/** A hash to check unknown phones against, so they take as long as known ones. */
function dummyHash(): string {
  dummy ??= hashSecret(newToken());
  return dummy;
}

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

export class TotpCodeRequiredError extends Error {}

/**
 * Enrols a TOTP authenticator; returns the base32 secret to show once as a QR code.
 * Replacing an existing enrolment needs a current code from it, unless the owner resets
 * someone else's (lost phone).
 */
export async function enableTotp(
  tx: Tx,
  userId: string,
  options: { currentCode?: string } = {},
): Promise<string> {
  await requireSelfOrAdmin(tx, userId);
  const { rows } = await tx.execute<{ actor: string; existing: string | null; t: string }>(sql`
    SELECT current_actor() AS actor, totp_secret_enc AS existing,
           extract(epoch FROM now())::bigint AS t
      FROM users WHERE id = ${userId}`);
  const { actor, existing, t } = rows[0]!;
  if (existing && actor === userId) {
    const ok =
      options.currentCode !== undefined &&
      verifyTotp(decryptSecret(existing), options.currentCode, Number(t));
    if (!ok)
      throw new TotpCodeRequiredError(
        "Replacing an authenticator needs a code from the current one",
      );
  }
  const secret = newTotpSecret();
  await withReason(tx, "audit.totpEnabled", () =>
    tx
      .update(users)
      .set({ totpSecretEnc: encryptSecret(secret) })
      .where(eq(users.id, userId)),
  );
  return secret;
}

/** Lifts a lock: recorded with the manager who did it and why (plan 03, A7). */
export async function unlockUser(tx: Tx, userId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Unlocking needs a reason");
  await requirePermission(tx, "UNLOCK_USER");
  await tx.insert(loginAttempts).values({
    userId,
    kind: "UNLOCK",
    success: true,
    recordedBy: sql`current_actor()`,
    reason: reason.trim(),
  });
}

/**
 * Two locks, computed from login_attempts, never stored (plan 03, A7):
 * - PIN_LOCKED: MAX_FAILURES wrong PINs in a row since the last success or unlock. The
 *   spec's lock (section 11): management unlocks; the user's sessions end.
 * - OFFICE_PAUSED: MAX_FAILURES wrong passwords or TOTP codes in the last 15 minutes.
 *   Office sign-in waits; sessions and the tablet are not touched, so a stranger who
 *   knows a phone number cannot lock the owner and every manager out.
 */
export type LockState = "NONE" | "PIN_LOCKED" | "OFFICE_PAUSED";

export async function lockState(db: Db | Tx, userId: string): Promise<LockState> {
  const { rows } = await db.execute<{ pin: number; office: number }>(sql`
    WITH reset AS (
      SELECT coalesce(max(b.at), '-infinity') AS at FROM login_attempts b
       WHERE b.user_id = ${userId} AND b.success
         AND b.kind IN ('PIN', 'PASSWORD', 'TOTP', 'UNLOCK'))
    SELECT
      (SELECT count(*)::int FROM login_attempts a, reset
        WHERE a.user_id = ${userId} AND NOT a.success AND a.kind = 'PIN' AND a.at > reset.at) AS pin,
      (SELECT count(*)::int FROM login_attempts a, reset
        WHERE a.user_id = ${userId} AND NOT a.success AND a.kind IN ('PASSWORD', 'TOTP')
          AND a.at > greatest(reset.at, now() - interval '15 minutes')) AS office`);
  const { pin, office } = rows[0]!;
  return pin >= MAX_FAILURES ? "PIN_LOCKED" : office >= MAX_FAILURES ? "OFFICE_PAUSED" : "NONE";
}

/** Locked until management unlocks (the PIN lock). */
export async function isLocked(db: Db | Tx, userId: string): Promise<boolean> {
  return (await lockState(db, userId)) === "PIN_LOCKED";
}

const blocks = (state: LockState, kind: CredentialKind) =>
  state === "PIN_LOCKED" || (state === "OFFICE_PAUSED" && kind !== "PIN");

// --- Sign-in ----------------------------------------------------------------------

async function rolesOf(db: Db | Tx, userId: string): Promise<Role[]> {
  const { rows } = await db.execute<{ role: Role }>(
    sql`SELECT role FROM user_roles WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );
  return rows.map((r) => r.role);
}

async function deviceFor(
  db: Db | Tx,
  deviceToken: string | undefined,
): Promise<string | undefined> {
  if (!deviceToken) return undefined;
  const [device] = await db
    .select({ id: tabletDevices.id })
    .from(tabletDevices)
    .where(
      and(eq(tabletDevices.tokenHash, hashToken(deviceToken)), isNull(tabletDevices.revokedAt)),
    );
  return device?.id;
}

/**
 * Runs one sign-in attempt for a user: serialized per user (an advisory lock), so a burst
 * of parallel guesses cannot all be checked before the lock applies (plan 03, A7).
 */
async function attempt(
  db: Db,
  userId: string,
  // The check may change the kind, e.g. a right password but a wrong TOTP code.
  kind: { value: CredentialKind },
  deviceId: string | undefined,
  check: (tx: Tx) => Promise<SignInStatus | "OK">,
  startAs?: "OFFICE" | "TABLET",
): Promise<SignInResult> {
  return withActor(db, { userId }, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    if (blocks(await lockState(tx, userId), kind.value)) return { status: "LOCKED" } as const;
    const outcome = await check(tx);
    if (outcome === "INVALID") {
      await tx.insert(loginAttempts).values({ userId, kind: kind.value, success: false, deviceId });
      const blocked = blocks(await lockState(tx, userId), kind.value);
      return { status: blocked ? "LOCKED" : "INVALID" } as const;
    }
    if (outcome !== "OK") return { status: outcome } as const;
    await tx.insert(loginAttempts).values({ userId, kind: kind.value, success: true, deviceId });
    const token = await startSession(tx, userId, startAs ?? "OFFICE", deviceId);
    return { status: "OK", token, userId } as const;
  });
}

async function startSession(
  tx: Tx,
  userId: string,
  kind: "OFFICE" | "TABLET",
  deviceId?: string,
): Promise<string> {
  const token = newToken();
  const hours = kind === "OFFICE" ? OFFICE_SESSION_HOURS : TABLET_SESSION_HOURS;
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
  return token;
}

async function activeUser(db: Db, where: ReturnType<typeof eq>) {
  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      pinHash: users.pinHash,
      totpSecretEnc: users.totpSecretEnc,
      isActive: users.isActive,
    })
    .from(users)
    .where(where);
  return user && user.isActive ? user : undefined;
}

/**
 * Office sign-in: phone and password, then a TOTP code for management and the owner.
 * On a registered tablet the session is a tablet session, with its idle lock.
 */
export async function signInWithPassword(
  db: Db,
  input: { phone: string; password: string; totpCode?: string; deviceToken?: string },
): Promise<SignInResult> {
  const user = await activeUser(db, eq(users.phone, input.phone.trim()));
  if (!user?.passwordHash) {
    // The same work as a real check, so the answer time does not reveal the phone exists.
    verifySecret(input.password, dummyHash());
    await db.insert(loginAttempts).values({ kind: "PASSWORD", success: false });
    return { status: "INVALID" };
  }
  const roles = await rolesOf(db, user.id);
  const deviceId = await deviceFor(db, input.deviceToken);
  const needsTotp = roles.some((r) => TOTP_ROLES.includes(r));

  const kind: { value: CredentialKind } = { value: "PASSWORD" };
  return attempt(
    db,
    user.id,
    kind,
    deviceId,
    async (tx) => {
      if (!verifySecret(input.password, user.passwordHash!)) return "INVALID";
      // Only after the right password, so the answer does not tell who has an account.
      if (!roles.some((r) => SIGN_IN_ROLES.includes(r))) return "NOT_ALLOWED";
      if (!needsTotp) return "OK";
      if (!user.totpSecretEnc) return "TOTP_NOT_ENROLLED";
      if (!input.totpCode) return "TOTP_REQUIRED";
      const { rows } = await tx.execute<{ t: string }>(
        sql`SELECT extract(epoch FROM now())::bigint AS t`,
      );
      if (verifyTotp(decryptSecret(user.totpSecretEnc), input.totpCode, Number(rows[0]!.t))) {
        return "OK";
      }
      // A wrong code is recorded as TOTP; it counts towards the lock like a password.
      kind.value = "TOTP";
      return "INVALID";
    },
    deviceId ? "TABLET" : "OFFICE",
  );
}

/**
 * Tablet: switch in with a personal PIN on a registered device (spec 01, section 1).
 * Management and the owner need their second factor, so they never sign in by PIN.
 */
export async function signInWithPin(
  db: Db,
  input: { deviceToken: string; userId: string; pin: string },
): Promise<SignInResult> {
  const deviceId = await deviceFor(db, input.deviceToken);
  if (!deviceId) return { status: "UNKNOWN_DEVICE" };
  // The user id comes from a form; anything but a uuid is simply not a user.
  if (!UUID.test(input.userId)) return { status: "INVALID" };
  const user = await activeUser(db, eq(users.id, input.userId));
  if (!user?.pinHash) {
    await db.insert(loginAttempts).values({ kind: "PIN", success: false, deviceId });
    return { status: "INVALID" };
  }
  if (!(await pinAllowed(db, user.id))) return { status: "NOT_ALLOWED" };
  return attempt(
    db,
    user.id,
    { value: "PIN" },
    deviceId,
    async () => (verifySecret(input.pin, user.pinHash!) ? "OK" : "INVALID"),
    "TABLET",
  );
}

/** May sign in by PIN: a staff role that needs no second factor (not mechanic only). */
export async function pinAllowed(db: Db | Tx, userId: string): Promise<boolean> {
  const roles = await rolesOf(db, userId);
  return roles.some((r) => SIGN_IN_ROLES.includes(r)) && !roles.some((r) => TOTP_ROLES.includes(r));
}

/** The people who can switch in on the tablet: active, with a PIN, allowed, not locked. */
export async function pinCandidates(db: Db): Promise<{ id: string; name: string; role: Role }[]> {
  const { rows } = await db.execute<{ id: string; name: string; role: Role }>(sql`
    SELECT u.id, u.full_name AS name,
           (SELECT r.role FROM user_roles r WHERE r.user_id = u.id AND r.revoked_at IS NULL
             AND r.role IN ('FORMEN', 'WAREHOUSEMAN', 'CASHIER', 'BOOKKEEPER')
             ORDER BY r.role LIMIT 1) AS role
      FROM users u
     WHERE u.is_active AND u.pin_hash IS NOT NULL
       AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.revoked_at IS NULL
                     AND r.role IN ('FORMEN', 'WAREHOUSEMAN', 'CASHIER', 'BOOKKEEPER'))
       AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.revoked_at IS NULL
                         AND r.role IN ('MANAGEMENT', 'OWNER'))
     ORDER BY u.full_name`);
  const result: { id: string; name: string; role: Role }[] = [];
  for (const row of rows) if (!(await isLocked(db, row.id))) result.push(row);
  return result;
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  kind: "OFFICE" | "TABLET";
}

/**
 * The signed-in user for a session token, or null. Ended, expired, idle (tablet),
 * deactivated or locked users' sessions are ended here and refused (R11). A tablet
 * session only works on its own registered, unrevoked tablet.
 */
export async function validateSession(
  db: Db,
  token: string,
  deviceToken?: string,
): Promise<SessionUser | null> {
  const { rows } = await db.execute<{
    id: string;
    user_id: string;
    kind: "OFFICE" | "TABLET";
    expired: boolean;
    idle: boolean;
    active: boolean;
    wrong_device: boolean;
  }>(sql`
    SELECT s.id, s.user_id, s.kind,
           s.expires_at <= now() AS expired,
           (s.kind = 'TABLET' AND now() - s.last_seen_at >
              make_interval(secs => coalesce((
                SELECT (value #>> '{}')::int FROM settings
                 WHERE key = 'tablet_idle_seconds' AND effective_from <= now()
                 ORDER BY effective_from DESC LIMIT 1), ${DEFAULT_IDLE_SECONDS}))) AS idle,
           u.is_active AS active,
           (s.kind = 'TABLET' AND NOT EXISTS (
              SELECT 1 FROM tablet_devices d
               WHERE d.id = s.device_id AND d.revoked_at IS NULL
                 AND d.token_hash = ${deviceToken ? hashToken(deviceToken) : ""})) AS wrong_device
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ${hashToken(token)} AND s.ended_at IS NULL`);
  const s = rows[0];
  if (!s) return null;
  const locked = s.active && (await isLocked(db, s.user_id));
  const endReason = s.expired
    ? "EXPIRED"
    : s.idle
      ? "IDLE_LOCK"
      : s.wrong_device
        ? "WRONG_DEVICE"
        : !s.active
          ? "USER_DEACTIVATED"
          : locked
            ? "USER_LOCKED"
            : null;
  const touch = withActor(db, { userId: s.user_id }, (tx) =>
    tx
      .update(sessions)
      .set(endReason ? { endedAt: sql`now()`, endReason } : { lastSeenAt: sql`now()` })
      .where(eq(sessions.id, s.id)),
  );
  // A deactivated user cannot act, so their session cannot be ended in their name;
  // it is refused here every time instead.
  if (endReason === "USER_DEACTIVATED") await touch.catch(() => undefined);
  else await touch;
  return endReason ? null : { sessionId: s.id, userId: s.user_id, kind: s.kind };
}

export class NotSignedInError extends Error {}

/**
 * Runs fn as the session's user, in one audited transaction (AC5). The actor comes from
 * the server-side session, never from the request body.
 */
export async function withSessionUser<T>(
  db: Db,
  session: { token: string | undefined; deviceToken?: string },
  fn: (tx: Tx, user: SessionUser) => Promise<T>,
  reason?: string,
): Promise<T> {
  const user = session.token ? await validateSession(db, session.token, session.deviceToken) : null;
  if (!user) throw new NotSignedInError("Not signed in");
  return withActor(db, { userId: user.userId, reason }, (tx) => fn(tx, user));
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
  if (name.trim() === "") throw new Error("A tablet needs a name");
  const token = newToken();
  await tx.insert(tabletDevices).values({ name: name.trim(), tokenHash: hashToken(token) });
  return token;
}

/** Revokes a tablet; its sessions are refused from the next request (WRONG_DEVICE). */
export async function revokeTablet(tx: Tx, deviceId: string): Promise<void> {
  await requirePermission(tx, "REGISTER_TABLET");
  await withReason(tx, "audit.tabletRevoked", () =>
    tx
      .update(tabletDevices)
      .set({ revokedAt: sql`now()` })
      .where(eq(tabletDevices.id, deviceId)),
  );
}
