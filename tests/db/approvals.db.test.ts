// Plan 03, P4: the approval engine (spec 00, section 6; AC3).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, documents } from "@/db/schema";
import { approveStep, pendingFor, rejectStep } from "@/lib/approvals";
import { withActor } from "@/lib/audit";
import { ApprovalNotAllowedError, ImmutableError, InvalidTransitionError } from "@/lib/db/errors";
import { PaymentMethodRequiredError, submitDocument } from "@/lib/documents";
import type { DocType } from "@/lib/documents/types";
import { createUser } from "./fixtures";
import { draft } from "./documents-fixtures";
import { createTestDb, type TestDb } from "./helpers";

let t: TestDb;
let anbardar: string;
let rehberlik: string;
let kassir: string;
let muhasib: string;
let owner: string;

beforeAll(async () => {
  t = await createTestDb();
  anbardar = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN"] });
  rehberlik = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
  kassir = await createUser(t.migratorPool, { roles: ["CASHIER"] });
  muhasib = await createUser(t.migratorPool, { roles: ["BOOKKEEPER"] });
  owner = await createUser(t.migratorPool, { roles: ["OWNER", "WAREHOUSEMAN"] });
});
afterAll(() => t.close());

async function submitted(type: DocType, paymentMethod?: "CASH" | "TRANSFER", creator = anbardar) {
  const id = await draft(t.db, creator, type);
  await withActor(t.db, { userId: creator }, (tx) => submitDocument(tx, id, { paymentMethod }));
  return id;
}

async function stepsOf(documentId: string) {
  return t.db
    .select()
    .from(approvals)
    .where(eq(approvals.documentId, documentId))
    .orderBy(approvals.round, approvals.stepNo);
}

async function statusOf(documentId: string) {
  const [d] = await t.db
    .select({ status: documents.status })
    .from(documents)
    .where(eq(documents.id, documentId));
  return d!.status;
}

const approve = (userId: string, approvalId: string, comment?: string) =>
  withActor(t.db, { userId }, (tx) => approveStep(tx, approvalId, comment));

describe("approval rounds come from the settings", () => {
  it("MEDAXIL: one management step; approving it approves the document", async () => {
    const doc = await submitted("MEDAXIL");
    const [step] = await stepsOf(doc);
    expect(step).toMatchObject({
      round: 1,
      stepNo: 1,
      requiredRole: "MANAGEMENT",
      status: "PENDING",
    });
    expect(await approve(rehberlik, step!.id, "Qəbul edildi")).toBe("APPROVED");
    expect(await statusOf(doc)).toBe("APPROVED");
    const [decided] = await stepsOf(doc);
    expect(decided).toMatchObject({
      status: "APPROVED",
      decidedBy: rehberlik,
      comment: "Qəbul edildi",
    });
    expect(decided!.decidedAt).toBeInstanceOf(Date);
  });

  it("SATIS: management, then the cashier for cash or the bookkeeper for transfer", async () => {
    const cash = await submitted("SATIS", "CASH");
    const transfer = await submitted("SATIS", "TRANSFER");
    expect((await stepsOf(cash)).map((s) => s.requiredRole)).toEqual(["MANAGEMENT", "CASHIER"]);
    expect((await stepsOf(transfer)).map((s) => s.requiredRole)).toEqual([
      "MANAGEMENT",
      "BOOKKEEPER",
    ]);

    const [first, second] = await stepsOf(cash);
    // In order: the cashier cannot go before management.
    await expect(approve(kassir, second!.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await approve(rehberlik, first!.id)).toBe("SUBMITTED");
    expect(await approve(kassir, second!.id)).toBe("APPROVED");

    await expect(
      withActor(t.db, { userId: anbardar }, async (tx) =>
        submitDocument(tx, await draft(t.db, anbardar, "SATIS")),
      ),
    ).rejects.toBeInstanceOf(PaymentMethodRequiredError);
  });

  it("TEHVIL_TESLIM has no steps and is approved on submission", async () => {
    const formen = await createUser(t.migratorPool, { roles: ["FORMEN"] });
    const doc = await submitted("TEHVIL_TESLIM", undefined, formen);
    expect(await stepsOf(doc)).toEqual([]);
    expect(await statusOf(doc)).toBe("APPROVED");
  });
});

describe("who may decide (enforced by the database)", () => {
  it("the creator cannot approve their own document, even as OWNER (AC3)", async () => {
    const doc = await submitted("MEDAXIL", undefined, owner);
    const [step] = await stepsOf(doc);
    await expect(approve(owner, step!.id)).rejects.toBeInstanceOf(ApprovalNotAllowedError);
  });

  it("a step needs its role; OWNER may decide any internal step", async () => {
    const doc = await submitted("ALIS");
    const [step] = await stepsOf(doc);
    await expect(approve(kassir, step!.id)).rejects.toBeInstanceOf(ApprovalNotAllowedError);
    expect(await approve(owner, step!.id)).toBe("APPROVED");
  });

  it("client steps cannot be decided by staff (client approval: milestone 6)", async () => {
    const doc = await submitted("QUSUR_AKTI");
    const [step] = await stepsOf(doc);
    expect(step!.requiredRole).toBe("CLIENT");
    await expect(approve(owner, step!.id)).rejects.toBeInstanceOf(ApprovalNotAllowedError);
  });

  it("a document becomes APPROVED only through its steps", async () => {
    const doc = await submitted("MEDAXIL");
    await expect(
      withActor(t.db, { userId: rehberlik, reason: "birbaşa" }, (tx) =>
        tx.update(documents).set({ status: "APPROVED" }).where(eq(documents.id, doc)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(
      withActor(t.db, { userId: rehberlik, reason: "birbaşa" }, (tx) =>
        tx.update(documents).set({ status: "REJECTED" }).where(eq(documents.id, doc)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("decided steps are frozen; decided_by and decided_at come from the database", async () => {
    const doc = await submitted("SILINME");
    const [step] = await stepsOf(doc);
    await withActor(t.db, { userId: rehberlik, reason: "x" }, (tx) =>
      tx
        .update(approvals)
        .set({ status: "APPROVED", decidedBy: kassir, decidedAt: new Date("2000-01-01") })
        .where(eq(approvals.id, step!.id)),
    );
    const [decided] = await stepsOf(doc);
    expect(decided!.decidedBy).toBe(rehberlik);
    expect(decided!.decidedAt!.getFullYear()).toBeGreaterThan(2020);
    await expect(
      withActor(t.db, { userId: rehberlik, reason: "x" }, (tx) =>
        tx.update(approvals).set({ comment: "sonra" }).where(eq(approvals.id, step!.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });
});

describe("rejection", () => {
  it("needs a comment, returns the document, and resubmission starts round 2", async () => {
    const doc = await submitted("SATIS", "TRANSFER");
    const [first, second] = await stepsOf(doc);
    await expect(
      withActor(t.db, { userId: rehberlik }, (tx) => rejectStep(tx, first!.id, "  ")),
    ).rejects.toThrow(/comment/);
    await withActor(t.db, { userId: rehberlik }, (tx) =>
      rejectStep(tx, first!.id, "Qiymət yüksəkdir"),
    );
    expect(await statusOf(doc)).toBe("REJECTED");
    const afterReject = await stepsOf(doc);
    expect(afterReject.map((s) => [s.id, s.status])).toEqual([
      [first!.id, "REJECTED"],
      [second!.id, "CANCELLED"],
    ]);

    await withActor(t.db, { userId: anbardar }, (tx) =>
      submitDocument(tx, doc, { paymentMethod: "TRANSFER" }),
    );
    const round2 = (await stepsOf(doc)).filter((s) => s.round === 2);
    expect(round2.map((s) => s.requiredRole)).toEqual(["MANAGEMENT", "BOOKKEEPER"]);
    // An old round's step cannot be decided any more.
    await expect(approve(rehberlik, first!.id)).rejects.toThrow(/REJECTED/);
    await approve(rehberlik, round2[0]!.id);
    expect(await approve(muhasib, round2[1]!.id)).toBe("APPROVED");
  });
});

describe("the management queue", () => {
  it("shows the next steps the user may decide, oldest first, never their own documents", async () => {
    const q = await createTestDb();
    try {
      const a = await createUser(q.migratorPool, { roles: ["WAREHOUSEMAN"] });
      const m = await createUser(q.migratorPool, { roles: ["MANAGEMENT", "WAREHOUSEMAN"] });
      const c = await createUser(q.migratorPool, { roles: ["CASHIER"] });
      const sub = async (creator: string, type: DocType, pay?: "CASH") => {
        const id = await draft(q.db, creator, type);
        await withActor(q.db, { userId: creator }, (tx) =>
          submitDocument(tx, id, { paymentMethod: pay }),
        );
        return id;
      };
      const older = await sub(a, "MEDAXIL");
      const sale = await sub(a, "SATIS", "CASH");
      const own = await sub(m, "MEDAXIL");
      await sub(a, "QUSUR_AKTI");

      const queue = await pendingFor(q.db, m);
      expect(queue.map((p) => p.documentId)).toEqual([older, sale]);
      expect(queue.map((p) => p.documentId)).not.toContain(own);
      // The cashier's step is not hers until management has approved.
      expect(await pendingFor(q.db, c)).toEqual([]);
      const [saleStep] = queue.filter((p) => p.documentId === sale);
      await withActor(q.db, { userId: m }, (tx) => approveStep(tx, saleStep!.approvalId));
      expect((await pendingFor(q.db, c)).map((p) => p.documentId)).toEqual([sale]);
    } finally {
      await q.close();
    }
  });
});
