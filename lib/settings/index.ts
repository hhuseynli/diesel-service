import { and, desc, eq, lte, sql } from "drizzle-orm";
import { settings } from "@/db/schema";
import type { Db, Tx } from "@/lib/db/types";

/** The value of a setting in effect now: the latest row with effective_from <= now(). */
export async function getSetting<T = unknown>(db: Db | Tx, key: string): Promise<T | undefined> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), lte(settings.effectiveFrom, sql`now()`)))
    .orderBy(desc(settings.effectiveFrom))
    .limit(1);
  return rows[0]?.value as T | undefined;
}
