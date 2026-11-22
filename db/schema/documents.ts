import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { DOC_STATUSES, DOC_TYPES } from "@/lib/documents/types";
import { createdAt, id, oneOf } from "./columns";
import { jobOrders } from "./jobs";
import { createdBy } from "./people";
import { contragents } from "./contragents";
import { vehicles } from "./vehicles";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const quantity = (name: string) => numeric(name, { precision: 12, scale: 3 });
const rate = (name: string) => numeric(name, { precision: 5, scale: 2 });

// One header structure for every document type (spec 00, section 3).
// Approved, posted and annulled rows are locked by the documents_guard trigger.
export const documents = pgTable(
  "documents",
  {
    id: id(),
    type: text("type").notNull(),
    number: text("number"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    docDate: date("doc_date"),
    jobOrderId: uuid("job_order_id").references((): AnyPgColumn => jobOrders.id),
    // Not in the spec's field list (plan 01, F3).
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    contragentId: uuid("contragent_id").references(() => contragents.id),
    vinSnapshot: text("vin_snapshot"),
    plateSnapshot: text("plate_snapshot"),
    // Not in the spec's field list (plan 01, F5).
    vatRate: rate("vat_rate"),
    totalExVat: money("total_ex_vat").notNull().default("0"),
    vatAmount: money("vat_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    supersedesId: uuid("supersedes_id")
      .unique()
      .references((): AnyPgColumn => documents.id),
    // Not in the spec's field list (plan 01, F4).
    reversesId: uuid("reverses_id").references((): AnyPgColumn => documents.id),
    annulReason: text("annul_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("documents_type", oneOf("type", DOC_TYPES)),
    check("documents_status", oneOf("status", DOC_STATUSES)),
    check("documents_number_format", sql`${t.number} ~ '^[A-Z]{2}-[0-9]{4}-[0-9]{6}$'`),
    check(
      "documents_number_by_status",
      sql`(${t.status} = 'DRAFT' AND ${t.number} IS NULL)
        OR (${t.status} IN ('SUBMITTED', 'REJECTED', 'APPROVED', 'POSTED') AND ${t.number} IS NOT NULL)
        OR ${t.status} = 'ANNULLED'`,
    ),
    check(
      "documents_annul_reason",
      sql`(${t.status} = 'ANNULLED') = (${t.annulReason} IS NOT NULL AND btrim(${t.annulReason}) <> '')`,
    ),
    check("documents_total", sql`${t.total} = ${t.totalExVat} + ${t.vatAmount}`),
    check("documents_version", sql`${t.version} >= 1`),
    check(
      "documents_version_has_predecessor",
      sql`(${t.version} > 1) = (${t.supersedesId} IS NOT NULL)`,
    ),
    unique("documents_type_number_version").on(t.type, t.number, t.version),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    lineNo: integer("line_no").notNull(),
    // Foreign key added with items in the warehouse milestone.
    itemId: uuid("item_id"),
    quantity: quantity("quantity").notNull(),
    unit: text("unit").notNull(),
    unitPrice: money("unit_price").notNull(),
    discount: money("discount").notNull().default("0"),
    discountReason: text("discount_reason"),
    vatRate: rate("vat_rate").notNull(),
    lineTotal: money("line_total").notNull(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    unique("document_lines_document_line_no").on(t.documentId, t.lineNo),
    check("document_lines_line_no", sql`${t.lineNo} >= 1`),
    check("document_lines_quantity_not_zero", sql`${t.quantity} <> 0`),
    check("document_lines_discount_not_negative", sql`${t.discount} >= 0`),
    // A discount needs a reason (spec 00, section 5.5; R5).
    check(
      "document_lines_discount_reason",
      sql`${t.discount} = 0 OR (${t.discountReason} IS NOT NULL AND btrim(${t.discountReason}) <> '')`,
    ),
  ],
);
