import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { createdBy, users } from "./people";

// Effective-dated: a change is a new row, never an update (spec 00, section 3).
export const settings = pgTable(
  "settings",
  {
    id: id(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [unique("settings_key_effective_from").on(t.key, t.effectiveFrom)],
);

// Gapless numbers per type per year, assigned only by lib/numbering assignNumber()
// (document-numbering skill). Not audited: the number appears in the document's audit row.
export const documentCounters = pgTable(
  "document_counters",
  {
    docType: text("doc_type").notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    primaryKey({ columns: [t.docType, t.year] }),
    check("document_counters_range", sql`${t.lastNumber} BETWEEN 1 AND 999999`),
  ],
);

// Append-only (spec 00, section 5). The app role may only SELECT; rows are written
// by the SECURITY DEFINER functions audit_row() and log_denied().
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    txid: bigint("txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id"),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    userId: uuid("user_id").references(() => users.id),
    reason: text("reason"),
    details: jsonb("details"),
  },
  (t) => [
    check("audit_log_action", sql`${t.action} IN ('INSERT', 'UPDATE', 'DENIED')`),
    check("audit_log_user", sql`${t.userId} IS NOT NULL OR ${t.action} = 'DENIED'`),
  ],
);

// Photos and scans: key and hash only, never overwritten (spec 00, section 8).
// linked_table/linked_id are optional; the referencing column is the authoritative link (plan 01, F8).
export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    storageKey: text("storage_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    linkedTable: text("linked_table"),
    linkedId: uuid("linked_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("attachments_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("attachments_size", sql`${t.sizeBytes} > 0`),
    check("attachments_link_pair", sql`(${t.linkedTable} IS NULL) = (${t.linkedId} IS NULL)`),
  ],
);
