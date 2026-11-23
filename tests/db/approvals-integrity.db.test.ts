// Plan 03, P4 (review fixes): approval rounds tied to the rules, cancellation, who decides.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, documents, userRoles } from "@/db/schema";
import { approveStep, pendingFor, rejectStep } from "@/lib/approvals";
import { withActor } from "@/lib/audit";
import {
  ApprovalNotAllowedError,
  ImmutableError,
  InvalidTransitionError,
  pgErrorOf,
} from "@/lib/db/errors";
import { annulDocument, submitDocument } from "@/lib/documents";
import { createUser } from "./fixtures";
import { draft } from "./documents-fixtures";
import { asActor, createTestDb, type TestDb } from "./helpers";

let t: TestDb;
let anbardar: string;
let rehberlik: string;
let owner: string;

beforeAll(async () => {
  t = await createTestDb();
  anbardar = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN"] });
  rehberlik = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
  owner = await createUser(t.migratorPool, { roles: ["OWNER"] });
});
afterAll(() => t.close());

async function submittedMedaxil(creator = anbardar) {
  const id = await draft(t.db, creator, "MEDAXIL");
  await withActor(t.db, { userId: creator }, (tx) => submitDocument(tx, id));
  return id;
}

const steps = (documentId: string) =>
  t.db
    .select()
    .from(approvals)
    .where(eq(approvals.documentId, documentId))
    .orderBy(approvals.round, approvals.stepNo);

describe("rounds are the rule in settings", () => {
  it("a step with another role, out of order, or a second open round is refused", async () => {
    // A sale whose first round was rejected: round 2 must start with management again.
    const sale = await draft(t.db, anbardar, "SATIS");
    await withActor(t.db, { userId: anbardar }, (tx) =>
      submitDocument(tx, sale, { paymentMethod: "CASH" }),
    );
    const [first] = await steps(sale);
    await withActor(t.db, { userId: rehberlik }, (tx) => rejectStep(tx, first!.id, "Yox"));
    const wrong = await withActor(t.db, { userId: anbardar, reason: "x" }, async (tx) => {
      await tx.update(documents).set({ status: "SUBMITTED" }).where(eq(documents.id, sale));
      await tx
        .insert(approvals)
        .values({ documentId: sale, round: 2, stepNo: 1, requiredRole: "CASHIER" });
    }).catch((e: unknown) => e);
    expect(pgErrorOf(wrong)).toMatchObject({ code: "DM005" });
    expect(String((wrong as Error).message)).toMatch(/must be MANAGEMENT/);

    const doc = await submittedMedaxil();
    await expect(
      withActor(t.db, { userId: anbardar }, (tx) =>
        tx
          .insert(approvals)
          .values({ documentId: doc, round: 2, stepNo: 1, requiredRole: "MANAGEMENT" }),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
    await expect(
      withActor(t.db, { userId: anbardar }, (tx) =>
        tx
          .insert(approvals)
          .values({ documentId: doc, round: 1, stepNo: 2, requiredRole: "MANAGEMENT" }),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("a step cannot be inserted as already approved", async () => {
    const doc = await submittedMedaxil();
    const error = await asActor(t.appPool, { userId: anbardar }, (c) =>
      c.query(
        "INSERT INTO approvals (document_id, round, step_no, required_role, status, method) VALUES ($1, 2, 1, 'MANAGEMENT', 'APPROVED', 'AUTO')",
        [doc],
      ),
    ).catch((e: unknown) => e);
    expect(pgErrorOf(error)?.code).toBe("DM005");
  });
});

describe("cancelling and rejecting", () => {
  it("open steps cannot be cancelled while the document is submitted; annulling cancels them", async () => {
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    await expect(
      withActor(t.db, { userId: anbardar, reason: "x" }, (tx) =>
        tx.update(approvals).set({ status: "CANCELLED" }).where(eq(approvals.id, step!.id)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await withActor(t.db, { userId: anbardar }, (tx) => annulDocument(tx, doc, "Səhv sənəd"));
    expect((await steps(doc)).map((s) => s.status)).toEqual(["CANCELLED"]);
  });

  it("the database refuses a rejection without a comment", async () => {
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    const error = await withActor(t.db, { userId: rehberlik, reason: "x" }, (tx) =>
      tx.update(approvals).set({ status: "REJECTED" }).where(eq(approvals.id, step!.id)),
    ).catch((e: unknown) => e);
    expect(pgErrorOf(error)).toMatchObject({
      code: "23514",
      constraint: "approvals_reject_comment",
    });
  });
});

describe("who decides", () => {
  it("the creator cannot reject either", async () => {
    const doc = await submittedMedaxil(owner);
    const [step] = await steps(doc);
    await expect(
      withActor(t.db, { userId: owner }, (tx) => rejectStep(tx, step!.id, "özüm")),
    ).rejects.toBeInstanceOf(ApprovalNotAllowedError);
  });

  it("whoever resubmitted a document cannot approve that round", async () => {
    const doc = await submittedMedaxil();
    const [first] = await steps(doc);
    await withActor(t.db, { userId: rehberlik }, (tx) => rejectStep(tx, first!.id, "Düzəlt"));
    // The owner resubmits someone else's document, then tries to approve it.
    await withActor(t.db, { userId: owner }, (tx) => submitDocument(tx, doc));
    const round2 = (await steps(doc)).filter((s) => s.round === 2);
    await expect(
      withActor(t.db, { userId: owner }, (tx) => approveStep(tx, round2[0]!.id)),
    ).rejects.toBeInstanceOf(ApprovalNotAllowedError);
    expect(
      await withActor(t.db, { userId: rehberlik }, (tx) => approveStep(tx, round2[0]!.id)),
    ).toBe("APPROVED");
  });

  it("a revoked role cannot decide", async () => {
    const former = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
    await withActor(t.db, { userId: owner, reason: "Vəzifə dəyişdi" }, (tx) =>
      tx
        .update(userRoles)
        .set({ revokedAt: new Date(), revokedBy: owner, revokeReason: "Vəzifə dəyişdi" })
        .where(and(eq(userRoles.userId, former), eq(userRoles.role, "MANAGEMENT"))),
    );
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    await expect(
      withActor(t.db, { userId: former }, (tx) => approveStep(tx, step!.id)),
    ).rejects.toBeInstanceOf(ApprovalNotAllowedError);
  });
});

describe("second verifier pass", () => {
  it("a pending step cannot carry a decider or a comment", async () => {
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    await expect(
      withActor(t.db, { userId: rehberlik, reason: "x" }, (tx) =>
        tx
          .update(approvals)
          .set({ decidedBy: anbardar, comment: "saxta" })
          .where(eq(approvals.id, step!.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("an old rejection cannot be replayed without a new decision", async () => {
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    await withActor(t.db, { userId: rehberlik }, (tx) => rejectStep(tx, step!.id, "Yox"));
    await expect(
      withActor(t.db, { userId: anbardar, reason: "x" }, async (tx) => {
        await tx.update(documents).set({ status: "SUBMITTED" }).where(eq(documents.id, doc));
        await tx.update(documents).set({ status: "REJECTED" }).where(eq(documents.id, doc));
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("the queue leaves out rounds the user submitted", async () => {
    const doc = await submittedMedaxil();
    const [step] = await steps(doc);
    await withActor(t.db, { userId: rehberlik }, (tx) => rejectStep(tx, step!.id, "Düzəlt"));
    await withActor(t.db, { userId: owner }, (tx) => submitDocument(tx, doc));
    expect((await pendingFor(t.db, owner)).map((p) => p.documentId)).not.toContain(doc);
    expect((await pendingFor(t.db, rehberlik)).map((p) => p.documentId)).toContain(doc);
  });
});
