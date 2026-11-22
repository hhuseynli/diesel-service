import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { ROLES } from "@/lib/users/roles";
import { actorDefault, createdAt, id, oneOf } from "./columns";

/** created_by for every table: the acting user, forced by the stamp_created trigger. */
export const createdBy = () =>
  uuid("created_by")
    .notNull()
    .default(actorDefault)
    .references((): AnyPgColumn => users.id);

export const users = pgTable(
  "users",
  {
    id: id(),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull().unique(),
    email: text("email"),
    pinHash: text("pin_hash"),
    // Office sign-in (plan 03, A6). Never copied into audit_log.
    passwordHash: text("password_hash"),
    totpSecretEnc: text("totp_secret_enc"),
    isActive: boolean("is_active").notNull().default(true),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("users_phone_format", sql`${t.phone} ~ '^\\+[0-9]{8,15}$'`),
    check("users_full_name_not_blank", sql`btrim(${t.fullName}) <> ''`),
    uniqueIndex("users_one_system_user")
      .on(t.isSystem)
      .where(sql`${t.isSystem}`),
  ],
);

// Roles are never deleted; taking one away is a dated revocation (plan 01, flag F6).
export const userRoles = pgTable(
  "user_roles",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("user_roles_role", oneOf("role", ROLES)),
    check(
      "user_roles_revoked_together",
      sql`(${t.revokedAt} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revokeReason} IS NULL)
        OR (${t.revokedAt} IS NOT NULL AND ${t.revokedBy} IS NOT NULL AND btrim(${t.revokeReason}) <> '')`,
    ),
    uniqueIndex("user_roles_one_active")
      .on(t.userId, t.role)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);
