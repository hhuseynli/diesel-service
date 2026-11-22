import { randomInt } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "@/db/schema";
import { approveStep, rejectStep } from "@/lib/approvals";
import { withActor } from "@/lib/audit";
import type { Role } from "@/lib/users/roles";
import { asActor, SYSTEM_USER_ID } from "./helpers";

/** A staff user, created by the system actor through the migration role (like a seed). */
export async function createUser(
  migratorPool: Pool,
  opts: { fullName?: string; roles?: Role[]; active?: boolean } = {},
): Promise<string> {
  return asActor(migratorPool, { userId: SYSTEM_USER_ID, reason: "test fixture" }, async (c) => {
    const phone = `+99450${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO users (full_name, phone, is_active) VALUES ($1, $2, $3) RETURNING id",
      [opts.fullName ?? "Test İstifadəçi", phone, opts.active ?? true],
    );
    const id = rows[0]!.id;
    for (const role of opts.roles ?? []) {
      await c.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [id, role]);
    }
    return id;
  });
}

async function pendingSteps(appPool: Pool, documentId: string): Promise<string[]> {
  const { rows } = await appPool.query<{ id: string }>(
    `SELECT id FROM approvals WHERE document_id = $1 AND status = 'PENDING' ORDER BY round, step_no`,
    [documentId],
  );
  return rows.map((r) => r.id);
}

/** Rejects a submitted document's next step through the approval engine. */
export async function rejectForTest(appPool: Pool, userId: string, documentId: string) {
  const [step] = await pendingSteps(appPool, documentId);
  if (!step) throw new Error("No pending approval step to reject");
  await withActor(drizzle(appPool, { schema }), { userId }, (tx) =>
    rejectStep(tx, step, "test rejection"),
  );
}

/** Approves every pending step of a submitted document through the approval engine. */
export async function approveForTest(appPool: Pool, userId: string, documentId: string) {
  for (const step of await pendingSteps(appPool, documentId)) {
    await withActor(drizzle(appPool, { schema }), { userId }, (tx) => approveStep(tx, step));
  }
}
