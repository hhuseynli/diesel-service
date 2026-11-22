// Plan 01, P9. Spec 00, acceptance criterion 4: document numbers have no gaps after
// creating, annulling and approving documents in any order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "@/lib/audit";
import { annulDocument, createNewVersion, submitDocument } from "@/lib/documents";
import type { DocType } from "@/lib/documents/types";
import { approveForTest, createUser } from "./fixtures";
import { draft, sequenceOf, SUBMIT_OPTS } from "./documents-fixtures";
import { createTestDb, type TestDb } from "./helpers";

let t: TestDb;
let creator: string;
let approver: string;

beforeAll(async () => {
  t = await createTestDb();
  creator = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN"] });
  approver = await createUser(t.migratorPool, { roles: ["OWNER"] });
});
afterAll(() => t.close());

/** Small deterministic PRNG, so a failing order can be reproduced from the seed. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

class Rollback extends Error {}

describe("gapless numbering in any order", () => {
  it.each([1, 7, 42])("seed %i: every type is numbered 1..n without gaps", async (seed) => {
    const random = prng(seed);
    const pick = <T>(list: T[]): T | undefined =>
      list.length ? list.splice(Math.floor(random() * list.length), 1)[0] : undefined;
    const types: DocType[] = ["MEDAXIL", "SATIS"];
    const drafts: { id: string; type: DocType }[] = [];
    const submittedDocs: string[] = [];
    const approvedDocs: string[] = [];

    for (let step = 0; step < 60; step++) {
      const r = random();
      if (r < 0.3 || drafts.length === 0) {
        const type = types[Math.floor(random() * types.length)]!;
        drafts.push({ id: await draft(t.db, creator, type), type });
      } else if (r < 0.55) {
        const d = pick(drafts)!;
        await withActor(t.db, { userId: creator }, (tx) => submitDocument(tx, d.id, SUBMIT_OPTS));
        submittedDocs.push(d.id);
      } else if (r < 0.65) {
        const d = pick(drafts)!;
        await withActor(t.db, { userId: creator }, (tx) => annulDocument(tx, d.id, "qaralama"));
      } else if (r < 0.75) {
        const id = pick(submittedDocs);
        if (id) await withActor(t.db, { userId: creator }, (tx) => annulDocument(tx, id, "ləğv"));
      } else if (r < 0.85) {
        const id = pick(submittedDocs);
        if (id) {
          await approveForTest(t.appPool, approver, id);
          approvedDocs.push(id);
        }
      } else if (r < 0.93) {
        // A submission that rolls back must not use up a number.
        const d = drafts[Math.floor(random() * drafts.length)]!;
        await expect(
          withActor(t.db, { userId: creator }, async (tx) => {
            await submitDocument(tx, d.id, SUBMIT_OPTS);
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
      } else {
        // A corrected version reuses its predecessor's number.
        const id = approvedDocs[Math.floor(random() * approvedDocs.length)];
        if (id) {
          const v = await withActor(t.db, { userId: creator }, (tx) => createNewVersion(tx, id));
          await withActor(t.db, { userId: creator }, (tx) => submitDocument(tx, v, SUBMIT_OPTS));
          approvedDocs.splice(approvedDocs.indexOf(id), 1);
        }
      }
    }

    for (const type of types) {
      const { rows } = await t.migratorPool.query<{ number: string }>(
        "SELECT DISTINCT number FROM documents WHERE type = $1 AND number IS NOT NULL",
        [type],
      );
      const sequences = rows.map((r) => sequenceOf(r.number)).sort((a, b) => a - b);
      expect(sequences, type).toEqual(sequences.map((_, i) => i + 1));
      const { rows: counter } = await t.migratorPool.query(
        "SELECT coalesce(max(last_number), 0) AS n FROM document_counters WHERE doc_type = $1",
        [type],
      );
      expect(Number(counter[0].n), type).toBe(sequences.length);
    }

    const { rows: annulled } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM documents WHERE status = 'ANNULLED' AND number IS NULL AND annul_reason = 'ləğv'",
    );
    expect(annulled[0].n, "annulled after numbering keeps its number").toBe(0);
  });
});
