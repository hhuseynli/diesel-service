import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { ROLES } from "@/lib/users/roles";
import { createdAt, id, sqlList } from "./columns";
import { documents } from "./documents";
import { createdBy, users } from "./people";

// One approval engine for every document type (spec 00, section 6; plan 03, A2-A4).
// A row per step and round; the approvals_guard trigger enforces who may decide and when.
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    round: integer("round").notNull(),
    stepNo: integer("step_no").notNull(),
    // A staff role, or CLIENT for client approval (milestone 6, plan 03 A1).
    requiredRole: text("required_role").notNull(),
    status: text("status").notNull().default("PENDING"),
    method: text("method").notNull().default("MANUAL"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    unique("approvals_document_round_step").on(t.documentId, t.round, t.stepNo),
    check("approvals_round_step", sql`${t.round} >= 1 AND ${t.stepNo} >= 1`),
    check("approvals_required_role", sql`${t.requiredRole} IN (${sqlList([...ROLES, "CLIENT"])})`),
    check("approvals_status", sql`${t.status} IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')`),
    check("approvals_method", sql`${t.method} IN ('MANUAL', 'AUTO')`),
    check(
      "approvals_decided",
      sql`(${t.status} IN ('APPROVED', 'REJECTED')) = (${t.decidedAt} IS NOT NULL)
        AND (${t.status} NOT IN ('APPROVED', 'REJECTED') OR ${t.decidedBy} IS NOT NULL OR ${t.method} = 'AUTO')`,
    ),
    check(
      "approvals_reject_comment",
      sql`${t.status} <> 'REJECTED' OR (${t.comment} IS NOT NULL AND btrim(${t.comment}) <> '')`,
    ),
  ],
);
