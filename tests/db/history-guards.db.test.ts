// Guarantees added after the verifier and spec-checker reviews of plan 01 (migrations
// 0008 and 0009, withReason), plus lifecycle paths the acceptance tests did not reach.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contragents, documents, userRoles, vehicles } from "@/db/schema";
import { withActor } from "@/lib/audit";
import { ImmutableError, pgErrorOf, ReasonRequiredError } from "@/lib/db/errors";
import { annulDocument, createDraft, createNewVersion, submitDocument } from "@/lib/documents";
import { assignNumber } from "@/lib/numbering";
import { getSetting } from "@/lib/settings";
import { createVehicle, recordPlate } from "@/lib/vehicles";
import { approveForTest, createUser, rejectForTest } from "./fixtures";
import { draft, submitted, SUBMIT_OPTS } from "./documents-fixtures";
import { asActor, createTestDb, sqlstateOf, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;
let userId: string;
let approver: string;

beforeAll(async () => {
  t = await createTestDb();
  userId = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN", "FORMEN"] });
  approver = await createUser(t.migratorPool, { roles: ["OWNER"] });
});
afterAll(() => t.close());

let vinCounter = 0;
async function vehicle(plate?: string) {
  const vin = `XTC65115RE${String(++vinCounter).padStart(7, "0")}`;
  const { id } = await withActor(t.db, { userId }, (tx) =>
    createVehicle(tx, { vin, plate: plate ? { display: plate, source: "INTAKE" } : undefined }),
  );
  return { id, vin };
}

describe("plate history is never overwritten", () => {
  it("a plate row cannot be renamed, moved or revived", async () => {
    const car = await vehicle("20-AA-200");
    const other = await vehicle();
    await withActor(t.db, { userId }, (tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "20-AA-201", source: "INTAKE" }),
    );
    for (const change of [
      sql`UPDATE vehicle_plates SET plate_display = '99-ZZ-999' WHERE vehicle_id = ${car.id}`,
      sql`UPDATE vehicle_plates SET vehicle_id = ${other.id} WHERE vehicle_id = ${car.id}`,
      sql`UPDATE vehicle_plates SET status = 'ACTIVE', valid_to = NULL
            WHERE vehicle_id = ${car.id} AND status = 'ENDED'`,
      sql`UPDATE vehicle_plates SET valid_from = '2000-01-01' WHERE vehicle_id = ${car.id}`,
    ]) {
      await expect(
        withActor(t.db, { userId, reason: "x" }, (tx) => tx.execute(change)),
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });
});

describe("roles are revoked, never edited", () => {
  async function roleOf(user: string) {
    const [row] = await t.db.select().from(userRoles).where(eq(userRoles.userId, user));
    return row!;
  }

  it("a role cannot be changed in place", async () => {
    const mechanic = await createUser(t.migratorPool, { roles: ["MECHANIC"] });
    const role = await roleOf(mechanic);
    await expect(
      withActor(t.db, { userId, reason: "x" }, (tx) =>
        tx.update(userRoles).set({ role: "OWNER" }).where(eq(userRoles.id, role.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("a role can be revoked once, and the revocation cannot be undone", async () => {
    const cashier = await createUser(t.migratorPool, { roles: ["CASHIER"] });
    const role = await roleOf(cashier);
    await withActor(t.db, { userId, reason: "işdən çıxıb" }, (tx) =>
      tx
        .update(userRoles)
        .set({ revokedAt: sql`now()`, revokedBy: userId, revokeReason: "işdən çıxıb" })
        .where(eq(userRoles.id, role.id)),
    );
    await expect(
      withActor(t.db, { userId, reason: "x" }, (tx) =>
        tx
          .update(userRoles)
          .set({ revokedAt: null, revokedBy: null, revokeReason: null })
          .where(eq(userRoles.id, role.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });
});

describe("documents keep what they were issued with", () => {
  it("a numbered document cannot move to another vehicle; a draft can", async () => {
    const a = await vehicle("30-BB-300");
    const b = await vehicle("30-BB-301");
    const draftId = await draft(t.db, userId, "QUSUR_AKTI", { vehicleId: a.id });
    await withActor(t.db, { userId, reason: "səhv avtomobil" }, (tx) =>
      tx.update(documents).set({ vehicleId: b.id }).where(eq(documents.id, draftId)),
    );
    await withActor(t.db, { userId }, (tx) => submitDocument(tx, draftId, SUBMIT_OPTS));
    await expect(
      withActor(t.db, { userId, reason: "x" }, (tx) =>
        tx.update(documents).set({ vehicleId: a.id }).where(eq(documents.id, draftId)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("a corrected version keeps the original's number and snapshots", async () => {
    const car = await vehicle("40-CC-400");
    const original = await submitted(t.db, userId, "MEDAXIL", { vehicleId: car.id });
    await approveForTest(t.appPool, approver, original.id);
    await withActor(t.db, { userId }, (tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "40-CC-401", source: "INTAKE" }),
    );
    const v2 = await withActor(t.db, { userId }, (tx) => createNewVersion(tx, original.id));
    await withActor(t.db, { userId }, (tx) => submitDocument(tx, v2, SUBMIT_OPTS));
    const { rows } = await t.migratorPool.query(
      "SELECT number, version, plate_snapshot, vin_snapshot FROM documents WHERE id = $1",
      [v2],
    );
    expect(rows[0]).toEqual({
      number: original.number,
      version: 2,
      plate_snapshot: "40-CC-400",
      vin_snapshot: car.vin,
    });
  });

  it("a rejected document is resubmitted with the same number, without using another", async () => {
    const doc = await submitted(t.db, userId, "QIYMET_PROTOKOLU");
    await rejectForTest(t.appPool, approver, doc.id);
    const again = await withActor(t.db, { userId }, (tx) =>
      submitDocument(tx, doc.id, SUBMIT_OPTS),
    );
    expect(again).toBe(doc.number);
    const next = await submitted(t.db, userId, "QIYMET_PROTOKOLU");
    expect(Number(next.number.slice(-6))).toBe(Number(doc.number.slice(-6)) + 1);

    await rejectForTest(t.appPool, approver, doc.id);
    await withActor(t.db, { userId }, (tx) => annulDocument(tx, doc.id, "müştəri imtina etdi"));
    const { rows } = await t.migratorPool.query(
      "SELECT status, number FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(rows[0]).toEqual({ status: "ANNULLED", number: doc.number });
  });

  it("submitting writes an audit row with the user and the submission reason", async () => {
    const doc = await submitted(t.db, userId, "QIYMET_PROTOKOLU");
    const { rows } = await t.migratorPool.query(
      `SELECT user_id, reason, before->>'status' AS before, after->>'status' AS after, after->>'number' AS number
         FROM audit_log WHERE table_name = 'documents' AND record_id = $1 AND action = 'UPDATE'`,
      [doc.id],
    );
    expect(rows).toEqual([
      {
        user_id: userId,
        reason: "audit.documentSubmitted",
        before: "DRAFT",
        after: "SUBMITTED",
        number: doc.number,
      },
    ]);
  });
});

describe("reasons do not leak between writes", () => {
  it("after a lib function, an unrelated update still needs its own reason", async () => {
    const [c] = await withActor(t.db, { userId }, (tx) =>
      tx
        .insert(contragents)
        .values({ kind: "FIZIKI", name: "Reason Test", isCustomer: true })
        .returning({ id: contragents.id }),
    );
    const car = await vehicle("50-DD-500");
    await expect(
      withActor(t.db, { userId }, async (tx) => {
        await recordPlate(tx, { vehicleId: car.id, plateDisplay: "50-DD-501", source: "INTAKE" });
        await tx.update(contragents).set({ name: "Changed" }).where(eq(contragents.id, c!.id));
      }),
    ).rejects.toBeInstanceOf(ReasonRequiredError);
  });
});

describe("numbering per year", () => {
  it("a counter from another year does not affect this year's numbers", async () => {
    const { rows } = await t.db.execute<{ y: number }>(
      sql`SELECT extract(year FROM baku_date())::int AS y`,
    );
    await asActor(t.migratorPool, { userId: SYSTEM_USER_ID }, (c) =>
      c.query(
        "INSERT INTO document_counters (doc_type, year, last_number) VALUES ('ELAVE_AKT', $1, 500)",
        [rows[0]!.y - 1],
      ),
    );
    const assigned = await withActor(t.db, { userId }, (tx) => assignNumber(tx, "ELAVE_AKT"));
    expect(assigned.sequence).toBe(1);
  });
});

describe("schema constraints and seed data", () => {
  it("the seed holds the legal entity and the 18% VAT rate", async () => {
    expect(await getSetting(t.db, "company")).toMatchObject({ legal_name: "Highest Service MMC" });
    expect(await getSetting(t.db, "vat_rate")).toEqual({ percent: "18.00" });
  });

  it("a discount needs a reason (R5)", async () => {
    const error = await withActor(t.db, { userId }, (tx) =>
      createDraft(tx, { type: "SATIS" }, [
        { quantity: "1", unit: "ədəd", unitPrice: "10.00", discount: "1.00", vatRate: "18.00" },
      ]),
    ).catch((e: unknown) => e);
    expect(pgErrorOf(error)).toMatchObject({
      code: "23514",
      constraint: "document_lines_discount_reason",
    });
  });

  it("the database refuses malformed VINs, whatever the app sends", async () => {
    for (const vin of ["WDB9634031I123456", "wdb9634031l123456", "SHORT"]) {
      expect(
        await sqlstateOf(
          asActor(t.appPool, { userId }, (c) =>
            c.query("INSERT INTO vehicles (vin) VALUES ($1)", [vin]),
          ),
        ),
        vin,
      ).toBe("23514");
    }
  });

  it("QR tokens are random, 32 hex characters and unique (R8)", async () => {
    const a = await vehicle();
    const b = await vehicle();
    const rows = await t.db
      .select({ token: vehicles.qrToken, vin: vehicles.vin })
      .from(vehicles)
      .where(sql`${vehicles.id} IN (${a.id}, ${b.id})`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.token).toMatch(/^[0-9a-f]{32}$/);
      expect(r.token).not.toContain(r.vin);
    }
    expect(rows[0]!.token).not.toBe(rows[1]!.token);
  });
});
