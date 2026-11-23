import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { documents } from "./documents";
import { jobOrders } from "./jobs";
import { createdBy, users } from "./people";
import { attachments } from "./system";
import { vehicles } from "./vehicles";

// Formen intake, inspection and workshop records (spec 01, section 2; plan 04).

export const INTAKE_PHOTO_SLOTS = [
  "ODOMETER",
  "FRONT",
  "REAR",
  "LEFT",
  "RIGHT",
  "DASHBOARD",
] as const;

/** The six required intake photos (spec 01, 3.4); written when the job is saved. */
export const intakePhotos = pgTable(
  "intake_photos",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id),
    slot: text("slot").notNull(),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    unique("intake_photos_job_slot").on(t.jobOrderId, t.slot),
    // A photo is evidence for one job only (plan 04, C3).
    unique("intake_photos_attachment").on(t.attachmentId),
    check(
      "intake_photos_slot",
      sql`${t.slot} IN ('ODOMETER', 'FRONT', 'REAR', 'LEFT', 'RIGHT', 'DASHBOARD')`,
    ),
  ],
);

/** Odometer at intake (spec 00, section 3; spec 01, 3.4; R9). */
export const odometerReadings = pgTable(
  "odometer_readings",
  {
    id: id(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .unique()
      .references(() => jobOrders.id),
    valueKm: integer("value_km").notNull(),
    photoId: uuid("photo_id")
      .notNull()
      .references(() => attachments.id),
    // Set by the database against the previous reading of the same vehicle.
    belowPrevious: boolean("below_previous").notNull().default(false),
    aboveDailyLimit: boolean("above_daily_limit").notNull().default(false),
    reason: text("reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("odometer_readings_value", sql`${t.valueKm} >= 0`),
    check(
      "odometer_readings_reason",
      sql`NOT ${t.belowPrevious} OR (${t.reason} IS NOT NULL AND btrim(${t.reason}) <> '')`,
    ),
  ],
);

/** Who handed the car over (spec 01, 3.5). OTP arrives with message delivery (plan 04, B5). */
export const intakeConfirmations = pgTable(
  "intake_confirmations",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .unique()
      .references(() => jobOrders.id),
    method: text("method").notNull(),
    signerName: text("signer_name").notNull(),
    signerPhone: text("signer_phone").notNull(),
    signatureAttachmentId: uuid("signature_attachment_id").references(() => attachments.id),
    // How the formen matched the car to its VIN (spec 01, 3.2; R8): the last six
    // characters checked on the car, or the VIN typed from the car for a new vehicle.
    vinCheck: text("vin_check").notNull(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("intake_confirmations_method", sql`${t.method} IN ('SIGNATURE', 'OTP')`),
    check(
      "intake_confirmations_vin_check",
      sql`${t.vinCheck} IN ('LAST6_CONFIRMED', 'NEW_VEHICLE')`,
    ),
    check(
      "intake_confirmations_signature",
      sql`${t.method} <> 'SIGNATURE' OR ${t.signatureAttachmentId} IS NOT NULL`,
    ),
    check(
      "intake_confirmations_signer",
      sql`btrim(${t.signerName}) <> '' AND btrim(${t.signerPhone}) <> ''`,
    ),
  ],
);

/**
 * A finding with photo or video evidence (spec 01, 3.6; R2). After "Anbara göndər"
 * findings are only added; a correction is a new row pointing at the one it corrects.
 */
export const inspectionFindings = pgTable(
  "inspection_findings",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id),
    mechanicId: uuid("mechanic_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    // Found during work (TEMIRDE): becomes an ELAVE_AKT request (spec 01, 3.7).
    additional: boolean("additional").notNull().default(false),
    correctsId: uuid("corrects_id").references((): AnyPgColumn => inspectionFindings.id),
    // A correction after "Anbara göndər" says why (spec 01, 3.6).
    correctionReason: text("correction_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("inspection_findings_description", sql`btrim(${t.description}) <> ''`),
    check(
      "inspection_findings_correction_reason",
      sql`(${t.correctsId} IS NULL AND ${t.correctionReason} IS NULL)
          OR (${t.correctsId} IS NOT NULL AND coalesce(btrim(${t.correctionReason}), '') <> '')`,
    ),
  ],
);

export const inspectionFindingAttachments = pgTable(
  "inspection_finding_attachments",
  {
    id: id(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => inspectionFindings.id),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [unique("inspection_finding_attachments_pair").on(t.findingId, t.attachmentId)],
);

/** Labour lines, priced by the warehouse (spec 01, 3.6). */
export const plannedServices = pgTable("planned_services", {
  id: id(),
  jobOrderId: uuid("job_order_id")
    .notNull()
    .references(() => jobOrders.id),
  description: text("description").notNull(),
  // Foreign key added with the catalog (milestone 5).
  itemId: uuid("item_id"),
  mechanicId: uuid("mechanic_id").references(() => users.id),
  additional: boolean("additional").notNull().default(false),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

/** The warehouse's queue (spec 01, 3.6): free text, matched to catalog items later. */
export const partsRequests = pgTable(
  "parts_requests",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    unitHint: text("unit_hint"),
    status: text("status").notNull().default("NEW"),
    // Foreign key added with the catalog (milestone 5).
    matchedItemId: uuid("matched_item_id"),
    additional: boolean("additional").notNull().default(false),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("parts_requests_status", sql`${t.status} IN ('NEW', 'MATCHED', 'CANCELLED')`),
    check("parts_requests_quantity", sql`${t.quantity} > 0`),
    check(
      "parts_requests_matched",
      sql`(${t.status} = 'MATCHED') = (${t.matchedItemId} IS NOT NULL)`,
    ),
  ],
);

/** Printed QR stickers; a reprint replaces the vehicle's token (spec 01, section 4; R8). */
export const qrStickers = pgTable(
  "qr_stickers",
  {
    id: id(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    qrToken: text("qr_token").notNull().unique(),
    status: text("status").notNull().default("ACTIVE"),
    replaceReason: text("replace_reason"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check("qr_stickers_status", sql`${t.status} IN ('ACTIVE', 'REPLACED')`),
    check(
      "qr_stickers_replace_reason",
      sql`(${t.status} = 'REPLACED') = (${t.replaceReason} IS NOT NULL AND btrim(${t.replaceReason}) <> '')`,
    ),
    uniqueIndex("qr_stickers_one_active_per_vehicle")
      .on(t.vehicleId)
      .where(sql`${t.status} = 'ACTIVE'`),
  ],
);

/** Decoder responses, kept so a VIN is never decoded (paid for) twice (R19). */
export const vinDecodes = pgTable("vin_decodes", {
  id: id(),
  vin: text("vin").notNull(),
  provider: text("provider").notNull(),
  rawResponse: jsonb("raw_response").notNull(),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

/** Quality check before HAZIR (spec 01, 3.7; plan 04, B10). */
export const qualityChecks = pgTable("quality_checks", {
  id: id(),
  jobOrderId: uuid("job_order_id")
    .notNull()
    .references(() => jobOrders.id),
  mechanicId: uuid("mechanic_id").references(() => users.id),
  itemsChecked: jsonb("items_checked").notNull(),
  passed: boolean("passed").notNull(),
  dashboardPhotoId: uuid("dashboard_photo_id")
    .notNull()
    .references(() => attachments.id),
  notes: text("notes"),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

/** Old parts taken off the car and what happened to them (spec 01, 3.7; R7; plan 04, B9). */
export const removedParts = pgTable(
  "removed_parts",
  {
    id: id(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id),
    description: text("description").notNull(),
    photoId: uuid("photo_id")
      .notNull()
      .references(() => attachments.id),
    disposition: text("disposition").notNull(),
    // Who replaced it (R3); the formen names the mechanic.
    mechanicId: uuid("mechanic_id").references(() => users.id),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check(
      "removed_parts_disposition",
      sql`${t.disposition} IN ('RETURNED_TO_CLIENT', 'DISPOSED', 'WARRANTY_CLAIM')`,
    ),
  ],
);

/** Who signed a document on screen, e.g. the person collecting the car (spec 01, 3.7). */
export const documentSignatures = pgTable(
  "document_signatures",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .unique()
      .references(() => documents.id),
    signerName: text("signer_name").notNull(),
    signerPhone: text("signer_phone").notNull(),
    signatureAttachmentId: uuid("signature_attachment_id")
      .notNull()
      .references(() => attachments.id),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    check(
      "document_signatures_signer",
      sql`btrim(${t.signerName}) <> '' AND btrim(${t.signerPhone}) <> ''`,
    ),
  ],
);
