import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db/types";
import type { DocType } from "@/lib/documents/types";
import type { JobStatus } from "@/lib/jobs/types";
import type { Role } from "@/lib/users/roles";

// The permission matrix (spec 00, section 10) and who triggers each job transition
// (section 4), enforced in lib before every write (plan 03, A5). OWNER may do
// everything. Approvals are also enforced by the database (approvals_guard).

export const ACTIONS = {
  CREATE_JOB: ["FORMEN"],
  CANCEL_JOB_AT_INTAKE: ["FORMEN", "MANAGEMENT"],
  CANCEL_JOB: ["MANAGEMENT"],
  RESOLVE_HOLD: ["MANAGEMENT"],
  RECORD_VEHICLE: ["FORMEN", "MANAGEMENT"],
  MANAGE_CONTRACTS: ["MANAGEMENT"],
  CREATE_WAREHOUSE_DOCUMENT: ["WAREHOUSEMAN"],
  CREATE_HANDOVER_DOCUMENT: ["FORMEN"],
  CHANGE_PRICE: ["MANAGEMENT", "WAREHOUSEMAN"],
  CONFIRM_CASH_PAYMENT: ["CASHIER"],
  CONFIRM_TRANSFER_PAYMENT: ["BOOKKEEPER"],
  VIEW_FINANCIALS: [],
  MANAGE_USERS: [],
  UNLOCK_USER: ["MANAGEMENT"],
  REGISTER_TABLET: ["MANAGEMENT"],
} as const satisfies Record<string, readonly Role[]>;
export type Action = keyof typeof ACTIONS;

/** Who may move a job into each status (section 4, "Who triggers"). */
const JOB_TRANSITIONS: Record<Exclude<JobStatus, "QEBUL" | "LEGV">, readonly Role[]> = {
  BAXIS: ["FORMEN"],
  QIYMETLENDIRME: ["WAREHOUSEMAN"],
  TESDIQ_GOZLEYIR: ["WAREHOUSEMAN"],
  // The client approves; until client approval arrives (milestone 6) management records it.
  TESDIQLENDI: ["MANAGEMENT"],
  HISSE_GOZLEYIR: ["WAREHOUSEMAN", "FORMEN"],
  TEMIRDE: ["FORMEN"],
  HAZIR: ["FORMEN"],
  TEHVIL_VERILDI: ["FORMEN"],
  ODENILDI: ["CASHIER", "BOOKKEEPER"],
  // Closing follows automatically from payment and handover.
  BAGLANDI: ["FORMEN", "CASHIER", "BOOKKEEPER"],
};

export function documentAction(type: DocType): Action {
  return type === "TEHVIL_TESLIM" ? "CREATE_HANDOVER_DOCUMENT" : "CREATE_WAREHOUSE_DOCUMENT";
}

/** The acting user's active roles, from the transaction's actor (lib/audit). */
export async function actorRoles(tx: Db | Tx): Promise<Role[]> {
  const { rows } = await tx.execute<{ role: Role }>(sql`
    SELECT role FROM user_roles WHERE user_id = current_actor() AND revoked_at IS NULL`);
  return rows.map((r) => r.role);
}

export class PermissionError extends Error {
  constructor(readonly action: string) {
    super(`Not permitted: ${action}`);
  }
}

function allowed(roles: Role[], permitted: readonly Role[]): boolean {
  return roles.includes("OWNER") || roles.some((r) => permitted.includes(r));
}

export async function can(tx: Db | Tx, action: Action): Promise<boolean> {
  return allowed(await actorRoles(tx), ACTIONS[action]);
}

export async function requirePermission(tx: Db | Tx, action: Action): Promise<void> {
  if (!(await can(tx, action))) throw new PermissionError(action);
}

/** Moving a job into `to` (LEGV has its own rule: formen at intake, management after). */
export async function requireJobTransition(tx: Db | Tx, from: JobStatus, to: JobStatus) {
  if (to === "LEGV") {
    await requirePermission(tx, from === "QEBUL" ? "CANCEL_JOB_AT_INTAKE" : "CANCEL_JOB");
    return;
  }
  if (to === "QEBUL") throw new PermissionError(`JOB_TO_${to}`);
  if (!allowed(await actorRoles(tx), JOB_TRANSITIONS[to])) {
    throw new PermissionError(`JOB_TO_${to}`);
  }
}
