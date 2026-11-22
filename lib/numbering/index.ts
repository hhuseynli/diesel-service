import { sql } from "drizzle-orm";
import type { DocType } from "@/lib/documents/types";
import { pgErrorOf } from "@/lib/db/errors";
import type { Tx } from "@/lib/db/types";
import { formatNumber, MAX_SEQUENCE } from "./format";
import { PREFIXES } from "./prefixes";

export interface AssignedNumber {
  number: string;
  year: number;
  sequence: number;
}

/**
 * The next gapless number for a document type in the current Asia/Baku year
 * (spec 00, section 7; document-numbering skill).
 *
 * One upsert: the counter row stays locked until the transaction ends, like
 * SELECT ... FOR UPDATE, and the first number of a year needs no separate insert.
 * A rollback undoes the increment, so no number is lost.
 * Call it only inside the transaction that moves the document out of draft.
 */
export async function assignNumber(tx: Tx, docType: DocType): Promise<AssignedNumber> {
  let row: { year: number; last_number: number } | undefined;
  try {
    const result = await tx.execute<{ year: number; last_number: number }>(sql`
      INSERT INTO document_counters (doc_type, year, last_number)
      VALUES (${docType}, extract(year FROM baku_date())::int, 1)
      ON CONFLICT (doc_type, year)
        DO UPDATE SET last_number = document_counters.last_number + 1
      RETURNING year, last_number`);
    row = result.rows[0];
  } catch (e) {
    if (pgErrorOf(e)?.constraint === "document_counters_range") {
      throw new RangeError(`${docType}: all ${MAX_SEQUENCE} numbers of this year are used`, {
        cause: e,
      });
    }
    throw e;
  }
  if (!row) throw new Error("document_counters upsert returned no row");
  return {
    number: formatNumber(PREFIXES[docType], row.year, row.last_number),
    year: row.year,
    sequence: row.last_number,
  };
}
