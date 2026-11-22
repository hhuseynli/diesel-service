import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { createdBy, users } from "./people";

// Operational tables for sign-in (plan 03, A7-A9). Not audited: last_seen_at changes on
// every request. What matters (sign-ins, failures, unlocks) is in login_attempts, and an
// account's lock is computed from it: five failures in a row since the last success or
// unlock (no column to race on, and the lock is nobody's action).

/** A registered shared tablet. Its long-lived device cookie holds the token. */
export const tabletDevices = pgTable("tablet_devices", {
  id: id(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").notNull(),
    deviceId: uuid("device_id").references(() => tabletDevices.id),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    createdBy: createdBy(),
  },
  (t) => [
    check("sessions_kind", sql`${t.kind} IN ('OFFICE', 'TABLET')`),
    check("sessions_tablet_device", sql`(${t.kind} = 'TABLET') = (${t.deviceId} IS NOT NULL)`),
    check("sessions_end", sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL)`),
  ],
);

/** Append-only record of sign-in events; failures count towards the lock (plan 03, A7). */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id),
    kind: text("kind").notNull(),
    success: boolean("success").notNull(),
    deviceId: uuid("device_id").references(() => tabletDevices.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // UNLOCK only: the manager who lifted the lock, and why (plan 03, A7).
    recordedBy: uuid("recorded_by").references(() => users.id),
    reason: text("reason"),
  },
  (t) => [
    check(
      "login_attempts_kind",
      sql`${t.kind} IN ('PIN', 'PASSWORD', 'TOTP', 'UNLOCK', 'SIGN_OUT')`,
    ),
    check(
      "login_attempts_unlock",
      sql`(${t.kind} = 'UNLOCK') = (${t.recordedBy} IS NOT NULL AND btrim(coalesce(${t.reason}, '')) <> '')`,
    ),
  ],
);
