// Plan 01, P10: the tests the document-numbering skill requires.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documents } from "@/db/schema";
import { withActor } from "@/lib/audit";
import { submitDocument } from "@/lib/documents";
import { assignNumber } from "@/lib/numbering";
import { PREFIXES } from "@/lib/numbering/prefixes";
import { approveForTest, createUser } from "./fixtures";
import { draft, sequenceOf } from "./documents-fixtures";
import { ImmutableError } from "@/lib/db/errors";
import { asActor, createTestDb, sqlstateOf, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;
let userId: string;
let approver: string;

beforeAll(async () => {
  t = await createTestDb();
  userId = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN"] });
  approver = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
});
afterAll(() => t.close());

class Rollback extends Error {}

describe("assignNumber", () => {
  it("50 concurrent submissions on 50 connections get 50 consecutive numbers", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(await draft(t.db, userId, "SATIS"));

    const numbers = await Promise.all(
      ids.map((id) => withActor(t.db, { userId }, (tx) => submitDocument(tx, id))),
    );

    expect(new Set(numbers).size).toBe(50);
    expect(numbers.map(sequenceOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    for (const n of numbers) expect(n).toMatch(/^ST-\d{4}-\d{6}$/);
  });

  it("a rolled-back transaction does not use up a number", async () => {
    const first = await withActor(t.db, { userId }, (tx) => assignNumber(tx, "ALIS"));
    await expect(
      withActor(t.db, { userId }, async (tx) => {
        await assignNumber(tx, "ALIS");
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    const next = await withActor(t.db, { userId }, (tx) => assignNumber(tx, "ALIS"));
    expect(next.sequence).toBe(first.sequence + 1);
  });

  it("uses the Asia/Baku year (UTC+4)", async () => {
    const { rows } = await t.db.execute<{ y1: number; y2: number }>(sql`
      SELECT extract(year FROM baku_date('2026-12-31 19:59:59+00'))::int AS y1,
             extract(year FROM baku_date('2026-12-31 20:00:00+00'))::int AS y2`);
    expect(rows[0]).toEqual({ y1: 2026, y2: 2027 });

    const assigned = await withActor(t.db, { userId }, (tx) => assignNumber(tx, "SILINME"));
    const { rows: now } = await t.db.execute<{ y: number }>(
      sql`SELECT extract(year FROM baku_date())::int AS y`,
    );
    expect(assigned.year).toBe(now[0]!.y);
    expect(assigned.number).toBe(`SL-${assigned.year}-000001`);
  });

  it("refuses to go past 999999", async () => {
    const { rows } = await t.db.execute<{ y: number }>(
      sql`SELECT extract(year FROM baku_date())::int AS y`,
    );
    await asActor(t.migratorPool, { userId: SYSTEM_USER_ID }, (c) =>
      c.query(
        "INSERT INTO document_counters (doc_type, year, last_number) VALUES ('MEDAXIL', $1, 999999)",
        [rows[0]!.y],
      ),
    );
    await expect(withActor(t.db, { userId }, (tx) => assignNumber(tx, "MEDAXIL"))).rejects.toThrow(
      RangeError,
    );
  });
});

describe("document_counters guard: numbering does not rest on the app alone", () => {
  it("the app role cannot move a counter except forward by one", async () => {
    await withActor(t.db, { userId }, (tx) => assignNumber(tx, "INVENTAR"));
    for (const statement of [
      "UPDATE document_counters SET last_number = last_number + 5 WHERE doc_type = 'INVENTAR'",
      "UPDATE document_counters SET last_number = last_number - 1 WHERE doc_type = 'INVENTAR'",
      "UPDATE document_counters SET year = year + 1 WHERE doc_type = 'INVENTAR'",
    ]) {
      await expect(
        withActor(t.db, { userId, reason: "x" }, (tx) => tx.execute(sql.raw(statement))),
        statement,
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });

  it("the app role can only start a counter at 1; the migration role may start elsewhere", async () => {
    await expect(
      withActor(t.db, { userId }, (tx) =>
        tx.execute(
          sql`INSERT INTO document_counters (doc_type, year, last_number) VALUES ('ALIS', 2099, 5)`,
        ),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
    await asActor(t.migratorPool, { userId: SYSTEM_USER_ID }, (c) =>
      c.query(
        "INSERT INTO document_counters (doc_type, year, last_number) VALUES ('ALIS', 2099, 5)",
      ),
    );
  });

  it("created_* on a counter cannot change, with the right error (DM005)", async () => {
    expect(
      await sqlstateOf(
        asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "x" }, (c) =>
          c.query("UPDATE document_counters SET created_at = created_at - interval '1 day'"),
        ),
      ),
    ).toBe("DM005");
  });
});

describe("numbers must come from the counter (second verifier pass)", () => {
  it("lib/numbering prefixes and the database's series_prefix agree", async () => {
    for (const [series, prefix] of Object.entries(PREFIXES)) {
      const { rows } = await t.db.execute<{ p: string }>(sql`SELECT series_prefix(${series}) AS p`);
      expect(rows[0]!.p, series).toBe(prefix);
    }
  });

  it("a document cannot take a number under another type's prefix", async () => {
    const id = await draft(t.db, userId, "QUSUR_AKTI");
    await expect(
      withActor(t.db, { userId, reason: "x" }, async (tx) => {
        const { year, sequence } = await assignNumber(tx, "QUSUR_AKTI");
        const forged = `EA-${year}-${String(sequence).padStart(6, "0")}`;
        await tx
          .update(documents)
          .set({ status: "SUBMITTED", number: forged })
          .where(eq(documents.id, id));
      }),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("a corrected version needs an approved predecessor of the same type, with the next version", async () => {
    const submittedOnly = await draft(t.db, userId, "SATIS");
    await withActor(t.db, { userId }, (tx) => submitDocument(tx, submittedOnly));
    const approved = await draft(t.db, userId, "SATIS");
    await withActor(t.db, { userId }, (tx) => submitDocument(tx, approved));
    await approveForTest(t.appPool, approver, approved);

    for (const [supersedesId, type, version] of [
      [submittedOnly, "SATIS", 2],
      [approved, "QUSUR_AKTI", 2],
      [approved, "SATIS", 7],
    ] as const) {
      await expect(
        withActor(t.db, { userId }, (tx) =>
          tx.insert(documents).values({ type, version, supersedesId }),
        ),
        `${type} v${version}`,
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });
});
