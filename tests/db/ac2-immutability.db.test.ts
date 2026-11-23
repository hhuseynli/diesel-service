// Plan 01, P8. Spec 00, acceptance criterion 2: editing an approved document, or deleting
// any record, fails at the database level, and the attempt is logged.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  contragents,
  documentLines,
  documents,
  partsRequests,
  vinDecodes,
} from "@/db/schema";
import { withActor, withReason } from "@/lib/audit";
import {
  DocumentLockedError,
  InvalidTransitionError,
  PermissionDeniedError,
} from "@/lib/db/errors";
import { addVehicle, createContract } from "@/lib/contracts";
import { registerTablet, setPin, signInWithPin } from "@/lib/auth";
import { annulDocument, createNewVersion, submitDocument } from "@/lib/documents";
import { addFinding, addPartsRequest, addPlannedService, recordRemovedPart } from "@/lib/intake";
import { openJob } from "@/lib/jobs";
import { createVehicle } from "@/lib/vehicles";
import { approveForTest, createUser } from "./fixtures";
import { draft, submitted, TWO_LINES } from "./documents-fixtures";
import { fakeAttachment, newClient, newJob, newVehicle, PATH_TO, walk } from "./jobs-fixtures";
import { asActor, createTestDb, sqlstateOf, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;
let creator: string;
let approver: string;

beforeAll(async () => {
  t = await createTestDb();
  creator = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN", "FORMEN", "MANAGEMENT"] });
  approver = await createUser(t.migratorPool, { roles: ["OWNER"] });
  // At least one row in every table, so row-level delete triggers have something to refuse.
  await withActor(t.db, { userId: creator }, async (tx) => {
    const { id: vehicleId } = await createVehicle(tx, {
      vin: "WDB9634031L000001",
      plate: { display: "90-AA-001", source: "INTAKE" },
    });
    const [company] = await tx
      .insert(contragents)
      .values({ kind: "HUQUQI", name: "Test MMC", isCustomer: true })
      .returning({ id: contragents.id });
    // Contract, contract vehicle, job order and its first status event (plan 02).
    const contractId = await createContract(tx, {
      contragentId: company!.id,
      number: "M-1",
      signedOn: "2026-01-01",
      validFrom: "2026-01-01",
    });
    await addVehicle(tx, contractId, vehicleId);
    await openJob(tx, { vehicleId, contragentId: company!.id, formenId: creator });
    await tx.insert(attachments).values({
      storageKey: "photos/test-1.jpg",
      sha256: "a".repeat(64),
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    });
  });
  await approvedDoc();
  // Sign-in tables (plan 03): a registered tablet, a PIN sign-in (session + attempt).
  const formen = await createUser(t.migratorPool, { roles: ["FORMEN"] });
  await withActor(t.db, { userId: formen }, (tx) => setPin(tx, formen, "4821"));
  const deviceToken = await withActor(t.db, { userId: creator }, (tx) =>
    registerTablet(tx, "Sex planşeti"),
  );
  const pin = await signInWithPin(t.db, { deviceToken, userId: formen, pin: "4821" });
  if (pin.status !== "OK") throw new Error(`PIN sign-in failed: ${pin.status}`);
  // Intake tables (plan 04): a job taken through inspection, work, quality check and handover.
  const mechanic = await createUser(t.migratorPool, { roles: ["MECHANIC"] });
  const car = await newVehicle(t.db, creator, "WDBAC2");
  const job = await newJob(t.db, creator, {
    vehicleId: car.id,
    contragentId: await newClient(t.db, creator),
  });
  await withActor(t.db, { userId: creator }, async (tx) => {
    await addFinding(tx, job.id, {
      mechanicId: mechanic,
      description: "Əyləc diskləri yeyilib",
      attachmentIds: [await fakeAttachment(tx)],
    });
    await addPlannedService(tx, job.id, { description: "Əyləc disklərinin dəyişdirilməsi" });
    const part = await addPartsRequest(tx, job.id, { description: "Əyləc diski", quantity: "2" });
    await withReason(tx, "lazım deyil", () =>
      tx.update(partsRequests).set({ status: "CANCELLED" }).where(eq(partsRequests.id, part)),
    );
    await tx.insert(vinDecodes).values({ vin: car.vin, provider: "TEST", rawResponse: {} });
  });
  await walk(t.db, creator, job.id, PATH_TO.TEMIRDE);
  await withActor(t.db, { userId: creator }, async (tx) =>
    recordRemovedPart(tx, job.id, {
      description: "Köhnə əyləc diski",
      photoId: await fakeAttachment(tx),
      disposition: "RETURNED_TO_CLIENT",
      mechanicId: mechanic,
    }),
  );
  await walk(t.db, creator, job.id, ["HAZIR", "TEHVIL_VERILDI"]);
});
afterAll(() => t.close());

async function approvedDoc(): Promise<{ id: string; number: string }> {
  const doc = await submitted(t.db, creator, "MEDAXIL");
  await approveForTest(t.appPool, approver, doc.id);
  return doc;
}

async function lastDenied() {
  const { rows } = await t.migratorPool.query(
    "SELECT * FROM audit_log WHERE action = 'DENIED' ORDER BY id DESC LIMIT 1",
  );
  return rows[0];
}

async function documentRow(id: string) {
  const { rows } = await t.migratorPool.query("SELECT * FROM documents WHERE id = $1", [id]);
  return rows[0];
}

describe("approved documents are locked", () => {
  it("updating the header fails and is logged as DENIED", async () => {
    const doc = await approvedDoc();
    const before = await documentRow(doc.id);
    await expect(
      withActor(t.db, { userId: creator, reason: "qiyməti artır" }, (tx) =>
        tx
          .update(documents)
          .set({ totalExVat: "999.00", total: "999.00" })
          .where(eq(documents.id, doc.id)),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);
    expect(await documentRow(doc.id)).toEqual(before);
    expect(await lastDenied()).toMatchObject({
      table_name: "documents",
      record_id: doc.id,
      user_id: creator,
      reason: "qiyməti artır",
      details: expect.objectContaining({ sqlstate: "DM001", operation: "DocumentLockedError" }),
    });
  });

  it("updating a line fails and is logged", async () => {
    const doc = await approvedDoc();
    await expect(
      withActor(t.db, { userId: creator, reason: "x" }, (tx) =>
        tx
          .update(documentLines)
          .set({ unitPrice: "1.00" })
          .where(eq(documentLines.documentId, doc.id)),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);
    expect(await lastDenied()).toMatchObject({ table_name: "document_lines", user_id: creator });
  });

  it("adding a line fails", async () => {
    const doc = await approvedDoc();
    await expect(
      withActor(t.db, { userId: creator }, (tx) =>
        tx.insert(documentLines).values({
          documentId: doc.id,
          lineNo: 9,
          quantity: "1",
          unit: "ədəd",
          unitPrice: "5.00",
          vatRate: "18.00",
          lineTotal: "5.00",
        }),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);
    expect(await lastDenied()).toMatchObject({
      table_name: "document_lines",
      user_id: creator,
      details: expect.objectContaining({ sqlstate: "DM001" }),
    });
  });

  it("annulling fails: corrections use a new version or a reversing document", async () => {
    const doc = await approvedDoc();
    await expect(
      withActor(t.db, { userId: creator }, (tx) => annulDocument(tx, doc.id, "səhv")),
    ).rejects.toBeInstanceOf(DocumentLockedError);
    expect(await lastDenied()).toMatchObject({
      table_name: "documents",
      record_id: doc.id,
      user_id: creator,
    });
  });

  it("APPROVED -> POSTED is allowed when only the status changes", async () => {
    const doc = await approvedDoc();
    await withActor(t.db, { userId: approver, reason: "audit.documentPosted" }, (tx) =>
      tx.update(documents).set({ status: "POSTED" }).where(eq(documents.id, doc.id)),
    );
    expect((await documentRow(doc.id)).status).toBe("POSTED");
  });

  it("APPROVED -> POSTED with any other change fails", async () => {
    const doc = await approvedDoc();
    await expect(
      withActor(t.db, { userId: approver, reason: "x" }, (tx) =>
        tx
          .update(documents)
          .set({ status: "POSTED", totalExVat: "1.00", total: "1.00" })
          .where(eq(documents.id, doc.id)),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);
  });

  it("POSTED and ANNULLED documents are frozen", async () => {
    const posted = await approvedDoc();
    await withActor(t.db, { userId: approver, reason: "post" }, (tx) =>
      tx.update(documents).set({ status: "POSTED" }).where(eq(documents.id, posted.id)),
    );
    await expect(
      withActor(t.db, { userId: approver, reason: "x" }, (tx) =>
        tx.update(documents).set({ status: "APPROVED" }).where(eq(documents.id, posted.id)),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);

    const annulled = await draft(t.db, creator);
    await withActor(t.db, { userId: creator }, (tx) => annulDocument(tx, annulled, "lazım deyil"));
    await expect(
      withActor(t.db, { userId: creator, reason: "x" }, (tx) =>
        tx.update(documents).set({ status: "DRAFT" }).where(eq(documents.id, annulled)),
      ),
    ).rejects.toBeInstanceOf(DocumentLockedError);
  });

  it("the lock holds for the owner role too, without relying on privileges", async () => {
    const doc = await approvedDoc();
    expect(
      await sqlstateOf(
        asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "x" }, (c) =>
          c.query("UPDATE documents SET total_ex_vat = 1, total = 1 WHERE id = $1", [doc.id]),
        ),
      ),
    ).toBe("DM001");
  });

  it("the line lock and the POSTED and ANNULLED freezes hold for the owner role too", async () => {
    const approved = await approvedDoc();
    const posted = await approvedDoc();
    await withActor(t.db, { userId: approver, reason: "post" }, (tx) =>
      tx.update(documents).set({ status: "POSTED" }).where(eq(documents.id, posted.id)),
    );
    const annulled = await draft(t.db, creator);
    await withActor(t.db, { userId: creator }, (tx) => annulDocument(tx, annulled, "lazım deyil"));

    const asOwner = (statement: string, id: string) =>
      sqlstateOf(
        asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "x" }, (c) =>
          c.query(statement, [id]),
        ),
      );
    for (const id of [approved.id, posted.id, annulled]) {
      expect(
        await asOwner("UPDATE document_lines SET unit_price = 1 WHERE document_id = $1", id),
      ).toBe("DM001");
      expect(
        await asOwner(
          `INSERT INTO document_lines (document_id, line_no, quantity, unit, unit_price, vat_rate, line_total)
           VALUES ($1, 99, 1, 'ədəd', 1, 18, 1)`,
          id,
        ),
      ).toBe("DM001");
      expect(
        await asOwner(
          "UPDATE documents SET status = 'ANNULLED', annul_reason = 'x' WHERE id = $1",
          id,
        ),
      ).toBe("DM001");
    }
  });

  it("status can only follow the lifecycle", async () => {
    const id = await draft(t.db, creator);
    await expect(
      withActor(t.db, { userId: creator, reason: "x" }, (tx) =>
        tx.update(documents).set({ status: "APPROVED" }).where(eq(documents.id, id)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId: creator }, (c) =>
          c.query("INSERT INTO documents (type, status) VALUES ('SATIS', 'APPROVED')"),
        ),
      ),
    ).toBe("DM006");
  });

  it("a correction is a new version with the same number; the original is unchanged", async () => {
    const original = await approvedDoc();
    const before = await documentRow(original.id);
    const versionId = await withActor(t.db, { userId: creator }, (tx) =>
      createNewVersion(tx, original.id),
    );
    const number = await withActor(t.db, { userId: creator }, (tx) =>
      submitDocument(tx, versionId),
    );
    expect(number).toBe(original.number);
    const version = await documentRow(versionId);
    expect(version).toMatchObject({
      version: 2,
      supersedes_id: original.id,
      number: original.number,
    });
    expect(await documentRow(original.id)).toEqual(before);
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM document_lines WHERE document_id = $1",
      [versionId],
    );
    expect(rows[0].n).toBe(TWO_LINES.length);
  });
});

describe("nothing is deleted", () => {
  let tables: string[];
  beforeAll(async () => {
    const { rows } = await t.migratorPool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    tables = rows.map((r) => r.tablename);
  });

  it("every table has at least one row for the owner-role checks", async () => {
    for (const table of tables) {
      const { rows } = await t.migratorPool.query(`SELECT count(*)::int AS n FROM "${table}"`);
      expect(rows[0].n, table).toBeGreaterThan(0);
    }
  });

  it("DELETE fails for the app role on every table, and is logged as DENIED", async () => {
    for (const table of tables) {
      await expect(
        withActor(t.db, { userId: creator, reason: "silmək" }, (tx) =>
          tx.execute(sql.raw(`DELETE FROM "${table}"`)),
        ),
        table,
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(await lastDenied(), table).toMatchObject({
        table_name: table,
        user_id: creator,
        details: expect.objectContaining({ sqlstate: "42501" }),
      });
    }
  });

  it("TRUNCATE fails for the app role on every table, and is logged as DENIED", async () => {
    for (const table of tables) {
      await expect(
        withActor(t.db, { userId: creator }, (tx) => tx.execute(sql.raw(`TRUNCATE "${table}"`))),
        table,
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(await lastDenied(), table).toMatchObject({ table_name: table, user_id: creator });
    }
  });

  it("a refused write without a valid actor is still logged, with no user", async () => {
    await expect(
      withActor(t.db, { userId: "not-a-uuid" }, (tx) =>
        tx.update(documents).set({ annulReason: "x" }),
      ),
    ).rejects.toThrow();
    expect(await lastDenied()).toMatchObject({ user_id: null });
  });

  it("DELETE and TRUNCATE fail for the owner role too (DM002)", async () => {
    for (const table of tables) {
      for (const statement of [`DELETE FROM "${table}"`, `TRUNCATE "${table}" CASCADE`]) {
        expect(
          await sqlstateOf(
            asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "x" }, (c) =>
              c.query(statement),
            ),
          ),
          statement,
        ).toBe("DM002");
      }
    }
  });

  it("audit_log and attachments cannot be updated, by the app or the owner", async () => {
    for (const table of ["audit_log", "attachments"]) {
      const column = table === "audit_log" ? "reason" : "mime_type";
      expect(
        await sqlstateOf(
          asActor(t.appPool, { userId: creator, reason: "x" }, (c) =>
            c.query(`UPDATE "${table}" SET ${column} = 'x'`),
          ),
        ),
        table,
      ).toBe("42501");
      expect(
        await sqlstateOf(
          asActor(t.migratorPool, { userId: SYSTEM_USER_ID, reason: "x" }, (c) =>
            c.query(`UPDATE "${table}" SET ${column} = 'x'`),
          ),
        ),
        table,
      ).toBe("DM005");
    }
  });
});
