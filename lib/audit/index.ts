import { sql } from "drizzle-orm";
import { toGuardError, type DbGuardError } from "@/lib/db/errors";
import type { Db, Tx } from "@/lib/db/types";

// Every write runs inside withActor (audit-rules skill, rules 2 and 6). The database
// reads the actor and the reason from these transaction settings in its triggers.

export interface Actor {
  /** The person who unlocked the session; never a shared or system user. */
  userId: string;
  /** Required by the database for every update (plan 01, F9). */
  reason?: string;
}

/**
 * Runs fn in a transaction attributed to the actor. If the database refuses the write
 * (locked document, delete, missing privilege...), the refusal is recorded as a DENIED
 * audit row in a separate transaction, then rethrown as a typed error.
 */
export async function withActor<T>(db: Db, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await applyActor(tx, actor);
      return fn(tx);
    });
  } catch (e) {
    const denial = toGuardError(e);
    if (!denial) throw e;
    await logDenied(db, actor, denial).catch((logError: unknown) => {
      // Never hide the original refusal behind a logging failure.
      console.error("audit: could not record a DENIED row", logError);
    });
    throw denial;
  }
}

/** Changes the reason for the following writes in this transaction. */
export async function setReason(tx: Tx, reason: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.reason', ${reason}, true)`);
}

/**
 * Runs fn with this reason, then restores the caller's reason, so a lib function's
 * reason never leaks onto later, unrelated updates in the same transaction.
 */
export async function withReason<T>(tx: Tx, reason: string, fn: () => Promise<T>): Promise<T> {
  const { rows } = await tx.execute<{ reason: string | null }>(
    sql`SELECT current_setting('app.reason', true) AS reason`,
  );
  await setReason(tx, reason);
  const result = await fn();
  await setReason(tx, rows[0]?.reason ?? "");
  return result;
}

async function applyActor(tx: Tx, actor: Actor): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${actor.userId}, true),
               set_config('app.reason', ${actor.reason ?? ""}, true)`,
  );
}

async function logDenied(db: Db, actor: Actor, denial: DbGuardError): Promise<void> {
  await db.transaction(async (tx) => {
    await applyActor(tx, actor);
    await tx.execute(
      sql`SELECT log_denied(${denial.table ?? null}, ${denial.name}, ${denial.sqlstate},
                            ${denial.message}, ${denial.recordId ?? null}::uuid)`,
    );
  });
}
