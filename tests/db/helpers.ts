import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "@/db/schema";
import type { Db } from "@/lib/db/types";
import { appUrl, migratorUrl, TEMPLATE_DB, TEST_DB_PREFIX, withDatabase } from "./env";

export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

export interface TestDb {
  name: string;
  /** The app role. Every guarantee is tested through this, as the application would. */
  db: Db;
  appPool: Pool;
  /** The owner role, to prove triggers hold even without the privilege checks. */
  migratorPool: Pool;
  close(): Promise<void>;
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A fresh database copied from the migrated template, for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const name = `${TEST_DB_PREFIX}${process.pid}_${randomBytes(4).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`));

  const appPool = new Pool({ connectionString: withDatabase(appUrl(), name), max: 60 });
  const migratorPool = new Pool({ connectionString: withDatabase(migratorUrl(), name), max: 5 });

  const { rows } = await appPool.query<{ current_user: string }>("SELECT current_user");
  if (rows[0]?.current_user !== "diesel_app") {
    throw new Error(`Database tests must run as diesel_app, not ${rows[0]?.current_user}`);
  }

  return {
    name,
    db: drizzle(appPool, { schema }),
    appPool,
    migratorPool,
    async close() {
      await appPool.end();
      await migratorPool.end();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

/** Runs SQL in one transaction on a pool with the given actor and reason set. */
export async function asActor<T>(
  pool: Pool,
  actor: { userId: string; reason?: string },
  fn: (c: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.reason', $2, true)",
      [actor.userId, actor.reason ?? ""],
    );
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** The SQLSTATE of a failed promise. */
export async function sqlstateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    // pg errors carry `code`; DbGuardError (from withActor) carries `sqlstate`.
    const err = e as { code?: string; sqlstate?: string; cause?: { code?: string } };
    return err.code ?? err.sqlstate ?? err.cause?.code;
  }
  throw new Error("Expected the operation to fail, but it succeeded");
}
