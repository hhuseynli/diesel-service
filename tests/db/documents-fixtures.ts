import { withActor } from "@/lib/audit";
import { createDraft, submitDocument, type DraftLine } from "@/lib/documents";

/** Sales need a payment method to pick their approval steps (plan 03, A2). */
export const SUBMIT_OPTS = { paymentMethod: "TRANSFER" } as const;
import type { DocType } from "@/lib/documents/types";
import type { Db } from "@/lib/db/types";

export const TWO_LINES: DraftLine[] = [
  { quantity: "2", unit: "ədəd", unitPrice: "45.50", vatRate: "18.00" },
  { quantity: "1.5", unit: "litr", unitPrice: "12.00", vatRate: "18.00" },
];

export async function draft(
  db: Db,
  userId: string,
  type: DocType = "QUSUR_AKTI",
  extra: { vehicleId?: string } = {},
): Promise<string> {
  return withActor(db, { userId }, (tx) => createDraft(tx, { type, ...extra }, TWO_LINES));
}

export async function submitted(
  db: Db,
  userId: string,
  type: DocType = "QUSUR_AKTI",
  extra: { vehicleId?: string } = {},
): Promise<{ id: string; number: string }> {
  const id = await draft(db, userId, type, extra);
  const number = await withActor(db, { userId }, (tx) => submitDocument(tx, id, SUBMIT_OPTS));
  return { id, number };
}

/** The 6-digit sequence of a number such as QA-2026-000123. */
export const sequenceOf = (number: string) => Number(number.slice(-6));
