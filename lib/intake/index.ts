import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  contragents,
  documentSignatures,
  inspectionFindingAttachments,
  inspectionFindings,
  intakeConfirmations,
  intakePhotos,
  INTAKE_PHOTO_SLOTS,
  jobOrders,
  odometerReadings,
  partsRequests,
  plannedServices,
  qrStickers,
  qualityChecks,
  removedParts,
  vehicles,
} from "@/db/schema";
import { withReason } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db/types";
import { createDraft, submitDocument } from "@/lib/documents";
import {
  moveJob,
  openJob,
  type ContractCheck,
  type JobStatus,
  type OpenJobInput,
} from "@/lib/jobs";
import { Quantity } from "@/lib/money";
import { requirePermission } from "@/lib/permissions";
import { getSetting } from "@/lib/settings";

// The formen's work on the tablet (spec 01; plan 04): receiving a car, inspection, and
// the workshop steps up to handover. The database enforces the preconditions of each
// status (job_orders_intake_guard); these functions are the normal way to meet them.

export type IntakeSlot = (typeof INTAKE_PHOTO_SLOTS)[number];
/** The six intake photo slots, in screen order (spec 01, 3.4). */
export const INTAKE_SLOTS = INTAKE_PHOTO_SLOTS;

export class OwnerQuestionRequiredError extends Error {
  constructor(readonly lastClientId: string) {
    super("The client differs from the last visit: ask whether the owner changed");
  }
}

/** Input the formen can correct (a malformed value), as opposed to a refused rule. */
export class ClientInputError extends Error {}

export class OdometerReasonRequiredError extends Error {
  constructor(readonly previousKm: number) {
    super(`The odometer is below the last reading (${previousKm} km): a reason is required`);
  }
}

/** Each intake photo is evidence for one job only: six distinct, unused attachments. */
export class IntakePhotoReusedError extends Error {}

export interface ReceiveInput extends Omit<OpenJobInput, "ownerChanged"> {
  /** Required only when the client differs from the vehicle's last job. */
  ownerChanged?: boolean;
  photos: Record<IntakeSlot, string>;
  odometer: { valueKm: number; reason?: string };
  confirmation: { signerName: string; signerPhone: string; signatureAttachmentId: string };
}

export interface ReceiveResult {
  jobId: string;
  number: string;
  contractCheck: ContractCheck;
  belowPrevious: boolean;
  aboveDailyLimit: boolean;
  /** A new vehicle gets its first QR sticker, to print now. */
  newStickerToken: string | null;
}

/** The client of the vehicle's last job, if any (spec 00, section 3a). */
export async function lastClientOf(db: Db | Tx, vehicleId: string): Promise<string | null> {
  const [last] = await db
    .select({ contragentId: jobOrders.contragentId })
    .from(jobOrders)
    .where(eq(jobOrders.vehicleId, vehicleId))
    .orderBy(desc(jobOrders.createdAt))
    .limit(1);
  return last?.contragentId ?? null;
}

/**
 * The odometer at intake (3.4; R9): whole kilometres, and a reason when it is below the
 * vehicle's last reading. Checked on the photo step and again at "Saxla".
 */
export async function checkOdometer(
  db: Db | Tx,
  vehicleId: string,
  odometer: { valueKm: number; reason?: string },
): Promise<void> {
  if (!Number.isSafeInteger(odometer.valueKm) || odometer.valueKm < 0) {
    throw new ClientInputError("The odometer is a whole number of kilometres");
  }
  const [previous] = await db
    .select({ valueKm: odometerReadings.valueKm })
    .from(odometerReadings)
    .where(eq(odometerReadings.vehicleId, vehicleId))
    .orderBy(desc(odometerReadings.createdAt))
    .limit(1);
  if (previous && odometer.valueKm < previous.valueKm && !odometer.reason?.trim()) {
    throw new OdometerReasonRequiredError(previous.valueKm);
  }
}

/**
 * "Saxla" at the end of intake (spec 01, 3.2-3.5): opens the job in QEBUL with its six
 * photos, the odometer reading and the confirmation, all in one transaction.
 */
export async function receiveVehicle(tx: Tx, input: ReceiveInput): Promise<ReceiveResult> {
  for (const slot of INTAKE_PHOTO_SLOTS) {
    if (!input.photos[slot]) throw new Error(`The ${slot} photo is missing`);
  }
  const photoIds = INTAKE_PHOTO_SLOTS.map((slot) => input.photos[slot]);
  if (new Set(photoIds).size !== photoIds.length) {
    throw new IntakePhotoReusedError("The six intake photos must be different files");
  }
  const [used] = await tx
    .select({ id: intakePhotos.id })
    .from(intakePhotos)
    .where(inArray(intakePhotos.attachmentId, photoIds))
    .limit(1);
  if (used) throw new IntakePhotoReusedError("An intake photo already belongs to another job");

  const lastClient = await lastClientOf(tx, input.vehicleId);
  const asked = lastClient !== null && lastClient !== input.contragentId;
  if (asked && input.ownerChanged === undefined) throw new OwnerQuestionRequiredError(lastClient);

  await checkOdometer(tx, input.vehicleId, input.odometer);

  const job = await openJob(tx, { ...input, ownerChanged: asked ? input.ownerChanged : undefined });
  await tx.insert(intakePhotos).values(
    INTAKE_PHOTO_SLOTS.map((slot) => ({
      jobOrderId: job.id,
      slot,
      attachmentId: input.photos[slot],
    })),
  );
  const [reading] = await tx
    .insert(odometerReadings)
    .values({
      vehicleId: input.vehicleId,
      jobOrderId: job.id,
      valueKm: input.odometer.valueKm,
      photoId: input.photos.ODOMETER,
      reason: input.odometer.reason?.trim() || null,
    })
    .returning({
      belowPrevious: odometerReadings.belowPrevious,
      aboveDailyLimit: odometerReadings.aboveDailyLimit,
    });
  await tx.insert(intakeConfirmations).values({
    jobOrderId: job.id,
    method: "SIGNATURE",
    signerName: input.confirmation.signerName.trim(),
    signerPhone: input.confirmation.signerPhone.trim(),
    signatureAttachmentId: input.confirmation.signatureAttachmentId,
  });

  const [sticker] = await tx
    .select({ id: qrStickers.id })
    .from(qrStickers)
    .where(eq(qrStickers.vehicleId, input.vehicleId))
    .limit(1);
  let newStickerToken: string | null = null;
  if (!sticker) {
    const [v] = await tx
      .select({ qrToken: vehicles.qrToken })
      .from(vehicles)
      .where(eq(vehicles.id, input.vehicleId));
    await tx.insert(qrStickers).values({ vehicleId: input.vehicleId, qrToken: v!.qrToken });
    newStickerToken = v!.qrToken;
  }

  return {
    jobId: job.id,
    number: job.number,
    contractCheck: job.contractCheck,
    belowPrevious: reading!.belowPrevious,
    aboveDailyLimit: reading!.aboveDailyLimit,
    newStickerToken,
  };
}

// --- Inspection (spec 01, 3.6) -----------------------------------------------------

/** Findings, services and parts are added from intake until the work is done. */
export class InspectionClosedError extends Error {}

const OPEN_FOR_FINDINGS = [
  "QEBUL",
  "BAXIS",
  "QIYMETLENDIRME",
  "TESDIQ_GOZLEYIR",
  "TESDIQLENDI",
  "HISSE_GOZLEYIR",
  "TEMIRDE",
];
/** From here the estimate is with the client: anything new is an ELAVE_AKT request. */
const ESTIMATE_SENT = ["TESDIQ_GOZLEYIR", "TESDIQLENDI", "HISSE_GOZLEYIR", "TEMIRDE"];

/**
 * Whether what is recorded now is additional or part of the inspection (spec 01, 3.6-3.7).
 * Decided from the job's status, never by the screen; the row lock keeps the status from
 * changing until the transaction ends.
 */
async function inspectionStage(tx: Tx, jobId: string): Promise<{ additional: boolean }> {
  const { rows } = await tx.execute<{ status: string }>(
    sql`SELECT status FROM job_orders WHERE id = ${jobId} FOR SHARE`,
  );
  const status = rows[0]?.status ?? "";
  if (!OPEN_FOR_FINDINGS.includes(status)) {
    throw new InspectionClosedError(`Nothing is added to a job in ${status || "no status"}`);
  }
  return { additional: ESTIMATE_SENT.includes(status) };
}

export async function addFinding(
  tx: Tx,
  jobId: string,
  input: { mechanicId: string; description: string; attachmentIds: string[] },
): Promise<string> {
  await requirePermission(tx, "RECORD_INSPECTION");
  const { additional } = await inspectionStage(tx, jobId);
  if (input.attachmentIds.length === 0) {
    throw new Error("A finding needs at least one photo or video (R2)");
  }
  const [finding] = await tx
    .insert(inspectionFindings)
    .values({
      jobOrderId: jobId,
      mechanicId: input.mechanicId,
      description: input.description.trim(),
      additional,
    })
    .returning({ id: inspectionFindings.id });
  await tx
    .insert(inspectionFindingAttachments)
    .values(input.attachmentIds.map((attachmentId) => ({ findingId: finding!.id, attachmentId })));
  return finding!.id;
}

export async function addPlannedService(
  tx: Tx,
  jobId: string,
  input: { description: string; mechanicId?: string },
): Promise<string> {
  await requirePermission(tx, "RECORD_INSPECTION");
  const { additional } = await inspectionStage(tx, jobId);
  const [row] = await tx
    .insert(plannedServices)
    .values({
      jobOrderId: jobId,
      description: input.description.trim(),
      mechanicId: input.mechanicId,
      additional,
    })
    .returning({ id: plannedServices.id });
  return row!.id;
}

export async function addPartsRequest(
  tx: Tx,
  jobId: string,
  input: { description: string; quantity: string; unitHint?: string },
): Promise<string> {
  await requirePermission(tx, "RECORD_INSPECTION");
  const { additional } = await inspectionStage(tx, jobId);
  const [row] = await tx
    .insert(partsRequests)
    .values({
      jobOrderId: jobId,
      description: input.description.trim(),
      quantity: Quantity.parse(input.quantity).toDb(),
      unitHint: input.unitHint?.trim() || null,
      additional,
    })
    .returning({ id: partsRequests.id });
  return row!.id;
}

/** "Anbara göndər": the parts list goes to the warehouse queue (BAXIS). */
export async function sendToWarehouse(tx: Tx, jobId: string): Promise<void> {
  await moveJob(tx, jobId, "BAXIS", "audit.sentToWarehouse");
}

// --- Workshop (spec 01, 3.7) -------------------------------------------------------

/** Start work (TEMIRDE). Until stock issues exist, every parts request must be settled (B8). */
export async function startWork(tx: Tx, jobId: string): Promise<void> {
  await moveJob(tx, jobId, "TEMIRDE", "audit.workStarted");
}

export async function recordRemovedPart(
  tx: Tx,
  jobId: string,
  input: {
    description: string;
    photoId: string;
    disposition: "RETURNED_TO_CLIENT" | "DISPOSED" | "WARRANTY_CLAIM";
  },
): Promise<string> {
  await requirePermission(tx, "RECORD_INSPECTION");
  const [row] = await tx
    .insert(removedParts)
    .values({ jobOrderId: jobId, ...input, description: input.description.trim() })
    .returning({ id: removedParts.id });
  return row!.id;
}

/** The checklist items from the `quality_checklist` setting (plan 04, B10). */
export async function qualityChecklist(db: Db | Tx): Promise<string[]> {
  return (
    (await getSetting<string[]>(db, "quality_checklist")) ?? [
      "TEST_DRIVE",
      "NO_WARNING_LIGHTS",
      "FLUIDS_CHECKED",
      "CAR_CLEAN",
    ]
  );
}

/**
 * The quality check (spec 01, 3.7). When every item passes, the job moves to HAZIR;
 * otherwise it stays in work. Returns whether it passed.
 */
export async function qualityCheck(
  tx: Tx,
  jobId: string,
  input: {
    items: Record<string, boolean>;
    dashboardPhotoId: string;
    mechanicId?: string;
    notes?: string;
  },
): Promise<boolean> {
  await requirePermission(tx, "RECORD_INSPECTION");
  const checklist = await qualityChecklist(tx);
  const passed = checklist.every((item) => input.items[item] === true);
  await tx.insert(qualityChecks).values({
    jobOrderId: jobId,
    mechanicId: input.mechanicId,
    itemsChecked: input.items,
    passed,
    dashboardPhotoId: input.dashboardPhotoId,
    notes: input.notes?.trim() || null,
  });
  if (passed) await moveJob(tx, jobId, "HAZIR", "audit.qualityPassed");
  return passed;
}

/**
 * Handover (spec 01, 3.7; plan 04, B11): the Təhvil-Təslim aktı is numbered, signed by
 * the person collecting the car, and the job moves to TEHVIL_VERILDI (or closes, if paid).
 */
export async function handOver(
  tx: Tx,
  jobId: string,
  signer: { signerName: string; signerPhone: string; signatureAttachmentId: string },
): Promise<{ documentId: string; number: string; status: JobStatus }> {
  const documentId = await createDraft(tx, { type: "TEHVIL_TESLIM", jobOrderId: jobId });
  await tx.insert(documentSignatures).values({
    documentId,
    signerName: signer.signerName.trim(),
    signerPhone: signer.signerPhone.trim(),
    signatureAttachmentId: signer.signatureAttachmentId,
  });
  const number = await submitDocument(tx, documentId);
  const status = await moveJob(tx, jobId, "TEHVIL_VERILDI", "audit.handedOver");
  return { documentId, number, status };
}

// --- QR stickers (spec 01, section 4; R8) -------------------------------------------

/** The vehicle a scanned sticker belongs to; a replaced sticker still resolves, with a warning. */
export async function findByQrToken(
  db: Db | Tx,
  token: string,
): Promise<{ vehicleId: string; replaced: boolean } | null> {
  const [sticker] = await db
    .select({ vehicleId: qrStickers.vehicleId, status: qrStickers.status })
    .from(qrStickers)
    .where(eq(qrStickers.qrToken, token.trim()));
  if (sticker) return { vehicleId: sticker.vehicleId, replaced: sticker.status === "REPLACED" };
  const [vehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.qrToken, token.trim()));
  return vehicle ? { vehicleId: vehicle.id, replaced: false } : null;
}

/** Reprints a lost or damaged sticker with a new token; the old one is marked REPLACED. */
export async function reprintSticker(tx: Tx, vehicleId: string, reason: string): Promise<string> {
  await requirePermission(tx, "PRINT_STICKER");
  if (reason.trim() === "") throw new Error("A reprint needs a reason");
  return withReason(tx, reason.trim(), async () => {
    await tx
      .update(qrStickers)
      .set({ status: "REPLACED", replaceReason: reason.trim() })
      .where(and(eq(qrStickers.vehicleId, vehicleId), eq(qrStickers.status, "ACTIVE")));
    const [v] = await tx
      .update(vehicles)
      .set({ qrToken: sql`replace(gen_random_uuid()::text, '-', '')` })
      .where(eq(vehicles.id, vehicleId))
      .returning({ qrToken: vehicles.qrToken });
    await tx.insert(qrStickers).values({ vehicleId, qrToken: v!.qrToken });
    return v!.qrToken;
  });
}

// --- Clients at intake (spec 01, 3.3) ------------------------------------------------

/** A new client from the intake screen; a legal entity needs its 10-digit VÖEN. */
export async function createClient(
  tx: Tx,
  input: { kind: "FIZIKI" | "HUQUQI"; name: string; voen?: string; phone?: string; email?: string },
): Promise<string> {
  await requirePermission(tx, "CREATE_JOB");
  const voen = input.voen?.trim() || null;
  if (input.kind === "HUQUQI" && !(voen && /^\d{10}$/.test(voen))) {
    throw new ClientInputError("A legal entity needs a 10-digit VÖEN");
  }
  if (input.name.trim() === "") throw new ClientInputError("A client needs a name");
  const [row] = await tx
    .insert(contragents)
    .values({
      kind: input.kind,
      name: input.name.trim(),
      voen,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      isCustomer: true,
    })
    .returning({ id: contragents.id });
  return row!.id;
}
