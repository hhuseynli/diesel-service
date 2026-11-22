import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

// Columns every table has (spec 00, section 3). created_at and created_by are
// overwritten by the stamp_created trigger, so values sent by the app are ignored.
// createdBy() lives in people.ts next to the users table it references.
export const id = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** The acting user from the transaction setting (set by lib/audit withActor). */
export const actorDefault = sql`(current_setting('app.user_id', true))::uuid`;

/** Builds `col IN ('A', 'B')` for CHECK constraints from a TS list of values. */
export const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);
