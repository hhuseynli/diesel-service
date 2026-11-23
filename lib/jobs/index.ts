import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { jobOrders, jobStatusEvents, userRoles } from "@/db/schema";
import { withReason } from "@/lib/audit";
import { checkContract } from "@/lib/contracts";
import type { Db, Tx } from "@/lib/db/types";
import { assignNumber } from "@/lib/numbering";
import { requireJobTransition, requirePermission } from "@/lib/permissions";
import type { Role } from "@/lib/users/roles";
import {
  TERMINAL_JOB_STATUSES,
  type ContractCheck,
  type ContractDecision,
  type JobStatus,
} from "./types";

export * from "./types";

// Job orders and their lifecycle (spec 00, section 4; plan 02). The database enforces
// which transitions exist and records every one (job_orders_guard, job_status_event).
// Who may trigger each one is the permission check of milestone 3.

/** The contract check warned and the formen has not chosen what to do (spec 01, 3.3). */
export class ContractDecisionRequiredError extends Error {
  constructor(readonly check: ContractCheck) {
    super(`Contract check is ${check}: a decision is required`);
  }
}

/** The car already has an open job; the screen opens it instead (spec 01, 3.2.3). */
export class OpenJobExistsError extends Error {
  constructor(readonly jobId: string) {
    super(`The vehicle already has an open job order (${jobId})`);
  }
}

/** The chosen formen or mechanic does not hold the role for it. */
export class WrongRoleError extends Error {}

export interface OpenJobInput {
  vehicleId: string;
  contragentId: string;
  formenId: string;
  mechanicId?: string;
  complaints?: string;
  contractDecision?: ContractDecision;
}

/**
 * Opens a job in QEBUL with the next IS number, after the contract check by VIN.
 * Only a car on a valid contract is linked to it (contract_id); for a warning the
 * check and the formen's decision are stored with the job (plan 02, C3).
 */
export async function openJob(
  tx: Tx,
  input: OpenJobInput,
): Promise<{ id: string; number: string; contractCheck: ContractCheck }> {
  await requirePermission(tx, "CREATE_JOB");
  const [open] = await tx
    .select({ id: jobOrders.id })
    .from(jobOrders)
    .where(
      and(
        eq(jobOrders.vehicleId, input.vehicleId),
        eq(jobOrders.carReleased, false),
        notInArray(jobOrders.status, [...TERMINAL_JOB_STATUSES]),
      ),
    );
  if (open) throw new OpenJobExistsError(open.id);

  if (!(await hasRole(tx, input.formenId, ["FORMEN", "OWNER"]))) {
    throw new WrongRoleError(`User ${input.formenId} is not a formen`);
  }
  if (input.mechanicId && !(await hasRole(tx, input.mechanicId, ["MECHANIC"]))) {
    throw new WrongRoleError(`User ${input.mechanicId} is not a mechanic`);
  }

  const { check, contractId } = await checkContract(tx, input);
  const warns = check === "NOT_ON_CONTRACT" || check === "CONTRACT_EXPIRED";
  if (warns && !input.contractDecision) throw new ContractDecisionRequiredError(check);

  const { number } = await assignNumber(tx, "JOB_ORDER");
  const [job] = await withReason(tx, "audit.jobOpened", () =>
    tx
      .insert(jobOrders)
      .values({
        number,
        vehicleId: input.vehicleId,
        contragentId: input.contragentId,
        contractId: check === "ON_CONTRACT" ? contractId : null,
        contractCheck: check,
        contractDecision: warns ? input.contractDecision : null,
        formenId: input.formenId,
        mechanicId: input.mechanicId,
        complaints: input.complaints,
      })
      .returning({ id: jobOrders.id }),
  );
  return { id: job!.id, number, contractCheck: check };
}

async function hasRole(tx: Tx, userId: string, roles: Role[]): Promise<boolean> {
  const [row] = await tx
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, userId),
        inArray(userRoles.role, roles),
        isNull(userRoles.revokedAt),
      ),
    );
  return Boolean(row);
}

/** Locks the job row and returns its status; a job that does not exist is an error. */
async function lockJob(tx: Tx, jobId: string): Promise<JobStatus> {
  const [job] = await tx
    .select({ status: jobOrders.status })
    .from(jobOrders)
    .where(eq(jobOrders.id, jobId))
    .for("update");
  if (!job) throw new Error(`Job order ${jobId} not found`);
  return job.status as JobStatus;
}

async function setStatus(tx: Tx, jobId: string, status: JobStatus, reason: string) {
  await withReason(tx, reason, () =>
    tx.update(jobOrders).set({ status }).where(eq(jobOrders.id, jobId)),
  );
}

/**
 * Moves a job to the next status. Payment (ODENILDI) and handover (TEHVIL_VERILDI)
 * happen in either order; whichever comes second also closes the job (plan 02, Q1).
 * Returns the status the job ends in.
 */
export async function moveJob(
  tx: Tx,
  jobId: string,
  to: Exclude<JobStatus, "LEGV">,
  reason: string,
): Promise<JobStatus> {
  if (reason.trim() === "") throw new Error("A status change needs a reason");
  // Locking first makes a second, concurrent move to the same status fail instead of
  // silently doing nothing.
  const current = await lockJob(tx, jobId);
  if (current === to) throw new Error(`Job ${jobId} is already ${to}`);
  await requireJobTransition(tx, current, to);
  await setStatus(tx, jobId, to, reason);

  if (to === "ODENILDI" || to === "TEHVIL_VERILDI") {
    const other = to === "ODENILDI" ? "TEHVIL_VERILDI" : "ODENILDI";
    const [done] = await tx
      .select({ id: jobStatusEvents.id })
      .from(jobStatusEvents)
      .where(and(eq(jobStatusEvents.jobOrderId, jobId), eq(jobStatusEvents.toStatus, other)));
    if (done) {
      await setStatus(tx, jobId, "BAGLANDI", "audit.jobClosed");
      return "BAGLANDI";
    }
  }
  return to;
}

/** Cancels a job (LEGV) with a reason; not possible after handover or payment. */
export async function cancelJob(tx: Tx, jobId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Cancelling a job needs a reason");
  await requireJobTransition(tx, await lockJob(tx, jobId), "LEGV");
  await withReason(tx, reason, () =>
    tx
      .update(jobOrders)
      .set({ status: "LEGV", cancelReason: reason })
      .where(eq(jobOrders.id, jobId)),
  );
}

/**
 * Releases a job held for management (spec 01, 3.3; plan 02, C3): it continues as a
 * separate paid job. The audit row records who decided and why. Management only.
 */
export async function resolveHold(tx: Tx, jobId: string, reason: string): Promise<void> {
  if (reason.trim() === "") throw new Error("Resolving a hold needs a reason");
  await requirePermission(tx, "RESOLVE_HOLD");
  await lockJob(tx, jobId);
  const updated = await withReason(tx, reason, () =>
    tx
      .update(jobOrders)
      .set({ contractDecision: "SEPARATE_PAID" })
      .where(and(eq(jobOrders.id, jobId), eq(jobOrders.contractDecision, "HOLD_FOR_MANAGEMENT")))
      .returning({ id: jobOrders.id }),
  );
  if (updated.length === 0) throw new Error(`Job ${jobId} is not held for management`);
}

/** The job's status history, oldest first. */
export async function jobHistory(db: Db | Tx, jobId: string) {
  return db
    .select({
      fromStatus: jobStatusEvents.fromStatus,
      toStatus: jobStatusEvents.toStatus,
      userId: jobStatusEvents.userId,
      reason: jobStatusEvents.reason,
      at: jobStatusEvents.at,
    })
    .from(jobStatusEvents)
    .where(eq(jobStatusEvents.jobOrderId, jobId))
    .orderBy(asc(jobStatusEvents.seq));
}
