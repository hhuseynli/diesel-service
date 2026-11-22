import { and, asc, eq, sql } from "drizzle-orm";
import { approvals, documentLines, documents, vehiclePlates, vehicles } from "@/db/schema";
import { withReason } from "@/lib/audit";
import type { Tx } from "@/lib/db/types";
import { Money, Quantity, Rate } from "@/lib/money";
import { assignNumber } from "@/lib/numbering";
import { documentAction, requirePermission } from "@/lib/permissions";
import type { Role } from "@/lib/users/roles";
import type { DocType } from "./types";

// Document lifecycle. The database enforces it (documents_guard, approvals_guard);
// these functions are the normal way to drive it. Submitting starts an approval round
// from the `approval_rules` setting (spec 00, section 6; plan 03, A2); deciding the steps
// is lib/approvals.

/** How a sale is paid; decides who confirms it in step 2 (plan 03, A2). */
export type PaymentMethod = "CASH" | "TRANSFER";

export class PaymentMethodRequiredError extends Error {
  constructor() {
    super("A sale needs its payment method to choose its approval steps");
  }
}

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
  await requirePermission(tx, documentAction(header.type));
  const [doc] = await tx
    .insert(documents)
    .values({ ...header, vatRate: header.vatRate ? Rate.parse(header.vatRate).toDb() : undefined })
    .returning({ id: documents.id });
  await insertLines(tx, doc!.id, lines);
  return doc!.id;
}

/** Creates the next approval round's steps; a type with no steps is approved at once. */
async function startApprovalRound(
  tx: Tx,
  documentId: string,
  type: DocType,
  paymentMethod: PaymentMethod | undefined,
) {
  const { rows } = await tx.execute<{ rule: string[]; round: number }>(sql`
    SELECT approval_rule(${type}) AS rule,
           coalesce((SELECT max(round) FROM approvals WHERE document_id = ${documentId}), 0) + 1 AS round`);
  const { rule, round } = rows[0]!;
  if (rule.length === 0) {
    await withReason(tx, "audit.documentApproved", () =>
      tx.update(documents).set({ status: "APPROVED" }).where(eq(documents.id, documentId)),
    );
    return;
  }
  const roles = rule.map((role): Role | "CLIENT" => {
    if (role !== "PAYMENT_CONFIRMER") return role as Role | "CLIENT";
    if (!paymentMethod) throw new PaymentMethodRequiredError();
    return paymentMethod === "CASH" ? "CASHIER" : "BOOKKEEPER";
  });
  await tx
    .insert(approvals)
    .values(roles.map((requiredRole, i) => ({ documentId, round, stepNo: i + 1, requiredRole })));
}

/**
 * Moves a draft (or a rejected document) to SUBMITTED and starts an approval round. A
 * draft gets its number here, in this transaction, together with the VIN and current
 * plate of its vehicle (section 3a). A corrected version is the same document revised:
 * it reuses its predecessor's number and snapshots (plan 01, Q4).
 */
export async function submitDocument(
  tx: Tx,
  documentId: string,
  options: { paymentMethod?: PaymentMethod } = {},
): Promise<string> {
  const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
  if (!doc) throw new Error(`Document ${documentId} not found`);
  await requirePermission(tx, documentAction(doc.type as DocType));

  if (doc.status === "REJECTED") {
    await withReason(tx, "audit.documentSubmitted", () =>
      tx.update(documents).set({ status: "SUBMITTED" }).where(eq(documents.id, documentId)),
    );
    await startApprovalRound(tx, documentId, doc.type as DocType, options.paymentMethod);
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
  await startApprovalRound(tx, documentId, doc.type as DocType, options.paymentMethod);
  return number;
}

/** Cancels a document that is not approved. A numbered document keeps its number. */
export async function annulDocument(tx: Tx, documentId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Annulling a document needs a reason");
  const [doc] = await tx
    .select({ type: documents.type })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) throw new Error(`Document ${documentId} not found`);
  await requirePermission(tx, documentAction(doc.type as DocType));
  await withReason(tx, reason, async () => {
    await tx
      .update(documents)
      .set({ status: "ANNULLED", annulReason: reason })
      .where(eq(documents.id, documentId));
    // Open approval steps end with the document (allowed once it has left SUBMITTED).
    await tx
      .update(approvals)
      .set({ status: "CANCELLED" })
      .where(and(eq(approvals.documentId, documentId), eq(approvals.status, "PENDING")));
  });
}

/**
 * Starts the correction of an approved or posted document: a draft copy with the next
 * version, pointing back through supersedes_id. The original is never changed.
 */
export async function createNewVersion(tx: Tx, documentId: string): Promise<string> {
  const [original] = await tx.select().from(documents).where(eq(documents.id, documentId));
  if (!original) throw new Error(`Document ${documentId} not found`);
  await requirePermission(tx, documentAction(original.type as DocType));
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
