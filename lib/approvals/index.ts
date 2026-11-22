import { and, eq, sql } from "drizzle-orm";
import { approvals, documents } from "@/db/schema";
import { withReason } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db/types";

// Deciding approval steps (spec 00, section 6; plan 03, A2-A3). Who may decide, in which
// order, and that the creator never approves their own document are enforced by the
// database (approvals_guard); decided_by and decided_at are set there too.

async function lockStep(tx: Tx, approvalId: string) {
  const [step] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .for("update");
  if (!step) throw new Error(`Approval step ${approvalId} not found`);
  if (step.status !== "PENDING") throw new Error(`Approval step ${approvalId} is ${step.status}`);
  return step;
}

/**
 * Approves a step. When it was the last open step of the round, the document becomes
 * APPROVED in the same transaction. Returns the document's status afterwards.
 */
export async function approveStep(
  tx: Tx,
  approvalId: string,
  comment?: string,
): Promise<"SUBMITTED" | "APPROVED"> {
  const step = await lockStep(tx, approvalId);
  await withReason(tx, comment?.trim() || "audit.approvalApproved", () =>
    tx
      .update(approvals)
      .set({ status: "APPROVED", comment: comment?.trim() || null, decidedAt: sql`now()` })
      .where(eq(approvals.id, approvalId)),
  );
  const { rows } = await tx.execute<{ done: boolean }>(sql`
    SELECT document_round_approved(d.id, d.type) AS done FROM documents d WHERE d.id = ${step.documentId}`);
  if (!rows[0]!.done) return "SUBMITTED";
  await withReason(tx, "audit.documentApproved", () =>
    tx.update(documents).set({ status: "APPROVED" }).where(eq(documents.id, step.documentId)),
  );
  return "APPROVED";
}

/**
 * Rejects a step with a comment (required). The document goes back to its creator as
 * REJECTED; the round's other open steps are cancelled. Resubmitting starts a new round.
 */
export async function rejectStep(tx: Tx, approvalId: string, comment: string): Promise<void> {
  if (comment.trim() === "") throw new Error("A rejection needs a comment");
  const step = await lockStep(tx, approvalId);
  await withReason(tx, comment, async () => {
    await tx
      .update(approvals)
      .set({ status: "REJECTED", comment: comment.trim(), decidedAt: sql`now()` })
      .where(eq(approvals.id, approvalId));
    await tx
      .update(approvals)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(approvals.documentId, step.documentId),
          eq(approvals.round, step.round),
          eq(approvals.status, "PENDING"),
        ),
      );
    await tx.update(documents).set({ status: "REJECTED" }).where(eq(documents.id, step.documentId));
  });
}

export interface PendingApproval {
  approvalId: string;
  documentId: string;
  documentType: string;
  documentNumber: string;
  requiredRole: string;
  stepNo: number;
  waitingSince: string;
}

/**
 * The approval queue for a user (spec 00, section 6): steps that are next in their
 * round, that the user's roles may decide, on documents the user did not create;
 * oldest first. Client steps are not in any staff queue (plan 03, A1).
 */
export async function pendingFor(db: Db | Tx, userId: string): Promise<PendingApproval[]> {
  const { rows } = await db.execute<{
    approval_id: string;
    document_id: string;
    document_type: string;
    document_number: string;
    required_role: string;
    step_no: number;
    waiting_since: string;
  }>(sql`
    SELECT a.id AS approval_id, d.id AS document_id, d.type AS document_type,
           d.number AS document_number, a.required_role, a.step_no,
           a.created_at::text AS waiting_since
      FROM approvals a JOIN documents d ON d.id = a.document_id
     WHERE a.status = 'PENDING' AND d.status = 'SUBMITTED'
       AND a.required_role <> 'CLIENT'
       AND d.created_by <> ${userId}
       -- nor the round its user submitted (approvals_guard refuses both)
       AND a.created_by <> ${userId}
       AND NOT EXISTS (SELECT 1 FROM approvals p
                        WHERE p.document_id = a.document_id AND p.round = a.round
                          AND p.step_no < a.step_no AND p.status <> 'APPROVED')
       AND EXISTS (SELECT 1 FROM user_roles r
                    WHERE r.user_id = ${userId} AND r.revoked_at IS NULL
                      AND r.role IN (a.required_role, 'OWNER'))
     ORDER BY a.created_at, a.step_no`);
  return rows.map((r) => ({
    approvalId: r.approval_id,
    documentId: r.document_id,
    documentType: r.document_type,
    documentNumber: r.document_number,
    requiredRole: r.required_role,
    stepNo: r.step_no,
    waitingSince: r.waiting_since,
  }));
}
