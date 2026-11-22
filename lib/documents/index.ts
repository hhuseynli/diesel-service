import { and, asc, eq } from "drizzle-orm";
import { documentLines, documents, vehiclePlates, vehicles } from "@/db/schema";
import { withReason } from "@/lib/audit";
import type { Tx } from "@/lib/db/types";
import { Money, Quantity, Rate } from "@/lib/money";
import { assignNumber } from "@/lib/numbering";
import type { DocType } from "./types";

// Document lifecycle helpers for milestone 1. Approval (steps, creator cannot approve)
// is the approval engine's job in milestone 3. The database enforces the lifecycle
// itself (documents_guard); these functions are the normal way to drive it.

export interface DraftLine {
  itemId?: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount?: string;
  discountReason?: string;
  vatRate: string;
}

export interface DraftHeader {
  type: DocType;
  vehicleId?: string;
  contragentId?: string;
  jobOrderId?: string;
  vatRate?: string;
  reversesId?: string;
}

/**
 * Line total before VAT: price x quantity - discount. Header totals and VAT wait for
 * the VAT method decision (D4, R16) in the warehouse milestone.
 */
function lineTotal(line: DraftLine): string {
  return Money.parse(line.unitPrice)
    .mulQty(Quantity.parse(line.quantity))
    .sub(Money.parse(line.discount ?? "0"))
    .toDb();
}

async function insertLines(tx: Tx, documentId: string, lines: DraftLine[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(documentLines).values(
    lines.map((line, i) => ({
      documentId,
      lineNo: i + 1,
      itemId: line.itemId,
      quantity: Quantity.parse(line.quantity).toDb(),
      unit: line.unit,
      unitPrice: Money.parse(line.unitPrice).toDb(),
      discount: Money.parse(line.discount ?? "0").toDb(),
      discountReason: line.discountReason,
      vatRate: Rate.parse(line.vatRate).toDb(),
      lineTotal: lineTotal(line),
    })),
  );
}

export async function createDraft(
  tx: Tx,
  header: DraftHeader,
  lines: DraftLine[] = [],
): Promise<string> {
  const [doc] = await tx
    .insert(documents)
    .values({ ...header, vatRate: header.vatRate ? Rate.parse(header.vatRate).toDb() : undefined })
    .returning({ id: documents.id });
  await insertLines(tx, doc!.id, lines);
  return doc!.id;
}

/**
 * Moves a draft (or a rejected document) to SUBMITTED. A draft gets its number here, in
 * this transaction, together with the VIN and current plate of its vehicle (section 3a).
 * A corrected version is the same document revised: it reuses its predecessor's number
 * and snapshots (plan 01, Q4).
 */
export async function submitDocument(tx: Tx, documentId: string): Promise<string> {
  const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
  if (!doc) throw new Error(`Document ${documentId} not found`);

  if (doc.status === "REJECTED") {
    await withReason(tx, "audit.documentSubmitted", () =>
      tx.update(documents).set({ status: "SUBMITTED" }).where(eq(documents.id, documentId)),
    );
    return doc.number!;
  }

  let number: string;
  let vinSnapshot: string | null = null;
  let plateSnapshot: string | null = null;
  if (doc.supersedesId) {
    const [predecessor] = await tx
      .select({
        number: documents.number,
        vinSnapshot: documents.vinSnapshot,
        plateSnapshot: documents.plateSnapshot,
      })
      .from(documents)
      .where(eq(documents.id, doc.supersedesId));
    number = predecessor!.number!;
    vinSnapshot = predecessor!.vinSnapshot;
    plateSnapshot = predecessor!.plateSnapshot;
  } else {
    number = (await assignNumber(tx, doc.type as DocType)).number;
    if (doc.vehicleId) {
      const [vehicle] = await tx
        .select({ vin: vehicles.vin, plate: vehiclePlates.plateDisplay })
        .from(vehicles)
        .leftJoin(
          vehiclePlates,
          and(eq(vehiclePlates.vehicleId, vehicles.id), eq(vehiclePlates.status, "ACTIVE")),
        )
        .where(eq(vehicles.id, doc.vehicleId));
      vinSnapshot = vehicle!.vin;
      plateSnapshot = vehicle!.plate;
    }
  }

  await withReason(tx, "audit.documentSubmitted", () =>
    tx
      .update(documents)
      .set({ status: "SUBMITTED", number, vinSnapshot, plateSnapshot })
      .where(eq(documents.id, documentId)),
  );
  return number;
}

/** Cancels a document that is not approved. A numbered document keeps its number. */
export async function annulDocument(tx: Tx, documentId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Annulling a document needs a reason");
  await withReason(tx, reason, () =>
    tx
      .update(documents)
      .set({ status: "ANNULLED", annulReason: reason })
      .where(eq(documents.id, documentId)),
  );
}

/**
 * Starts the correction of an approved or posted document: a draft copy with the next
 * version, pointing back through supersedes_id. The original is never changed.
 */
export async function createNewVersion(tx: Tx, documentId: string): Promise<string> {
  const [original] = await tx.select().from(documents).where(eq(documents.id, documentId));
  if (!original) throw new Error(`Document ${documentId} not found`);
  if (original.status !== "APPROVED" && original.status !== "POSTED") {
    throw new Error(`Only approved or posted documents get a new version, not ${original.status}`);
  }
  const lines = await tx
    .select()
    .from(documentLines)
    .where(eq(documentLines.documentId, documentId))
    .orderBy(asc(documentLines.lineNo));

  const [copy] = await tx
    .insert(documents)
    .values({
      type: original.type,
      version: original.version + 1,
      supersedesId: original.id,
      jobOrderId: original.jobOrderId,
      vehicleId: original.vehicleId,
      contragentId: original.contragentId,
      vatRate: original.vatRate,
      totalExVat: original.totalExVat,
      vatAmount: original.vatAmount,
      total: original.total,
    })
    .returning({ id: documents.id });

  if (lines.length > 0) {
    await tx.insert(documentLines).values(
      lines.map((l) => ({
        documentId: copy!.id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        discount: l.discount,
        discountReason: l.discountReason,
        vatRate: l.vatRate,
        lineTotal: l.lineTotal,
      })),
    );
  }
  return copy!.id;
}
