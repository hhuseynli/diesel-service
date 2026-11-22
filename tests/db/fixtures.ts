import { randomInt } from "node:crypto";
import type { Pool } from "pg";
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

/** Returns a submitted document to its creator (the approval engine's job in milestone 3). */
export async function rejectForTest(appPool: Pool, userId: string, documentId: string) {
  await asActor(appPool, { userId, reason: "test rejection" }, (c) =>
    c.query("UPDATE documents SET status = 'REJECTED' WHERE id = $1 AND status = 'SUBMITTED'", [
      documentId,
    ]),
  );
}

/**
 * Approves a submitted document directly. The approval engine (creator cannot approve,
 * approval steps) arrives in milestone 3; until then tests use this fixture.
 */
export async function approveForTest(appPool: Pool, userId: string, documentId: string) {
  await asActor(appPool, { userId, reason: "test approval" }, (c) =>
    c.query("UPDATE documents SET status = 'APPROVED' WHERE id = $1 AND status = 'SUBMITTED'", [
      documentId,
    ]),
  );
}
