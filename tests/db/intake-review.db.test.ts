// Plan 04, review fixes (migrations 0027-0028): rules that moved from lib into the
// database, corrections, the VIN check record, attribution (AC8) and sticker reprints.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  inspectionFindingAttachments,
  inspectionFindings,
  intakeConfirmations,
  plannedServices,
  removedParts,
} from "@/db/schema";
import { withActor } from "@/lib/audit";
import type { Tx } from "@/lib/db/types";
import {
  addFinding,
  addPartsRequest,
  addPlannedService,
  assignMechanic,
  ClientInputError,
  correctFinding,
  findByQrToken,
  INTAKE_SLOTS,
  IntakePhotoReusedError,
  receiveVehicle,
  recordRemovedPart,
  reprintSticker,
  type ReceiveInput,
} from "@/lib/intake";
import { createUser } from "./fixtures";
import { createTestDb, sqlstateOf, type TestDb } from "./helpers";
import { fakeAttachment, newClient, newJob, newVehicle, PATH_TO, walk } from "./jobs-fixtures";

let t: TestDb;
let formen: string;
let otherFormen: string;
let mechanic: string;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  formen = await createUser(t.migratorPool, { roles: ["FORMEN", "OWNER"] });
  otherFormen = await createUser(t.migratorPool, { roles: ["FORMEN"] });
  mechanic = await createUser(t.migratorPool, { roles: ["MECHANIC"] });
  client = await newClient(t.db, formen);
});
afterAll(() => t.close());

const as = <T>(fn: (tx: Tx) => Promise<T>, userId = formen) => withActor(t.db, { userId }, fn);

async function jobAt(status: keyof typeof PATH_TO, prefix: string) {
  const car = await newVehicle(t.db, formen, prefix);
  const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
  await walk(t.db, formen, job.id, PATH_TO[status]);
  return { ...job, vehicleId: car.id };
}

describe("what is added to a job, and when (0028)", () => {
  it("the database marks rows additional once the estimate is with the client", async () => {
    const job = await jobAt("QEBUL", "RVWA");
    // A client cannot make an inspection row additional, or the other way round.
    await as((tx) =>
      tx
        .insert(plannedServices)
        .values({ jobOrderId: job.id, description: "Yağ", additional: true }),
    );
    await walk(t.db, formen, job.id, ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR"]);
    await as((tx) => addPlannedService(tx, job.id, { description: "Filtr" }));
    const rows = await t.db
      .select({ d: plannedServices.description, additional: plannedServices.additional })
      .from(plannedServices)
      .where(eq(plannedServices.jobOrderId, job.id))
      .orderBy(plannedServices.createdAt);
    expect(rows).toEqual([
      { d: "Yağ", additional: false },
      { d: "Filtr", additional: true },
    ]);
  });

  it("nothing is added once the work is done", async () => {
    const job = await jobAt("HAZIR", "RVWB");
    expect(
      await sqlstateOf(
        as((tx) => addPartsRequest(tx, job.id, { description: "x", quantity: "1" })),
      ),
    ).toBe("DM001");
    expect(await sqlstateOf(as((tx) => addPlannedService(tx, job.id, { description: "x" })))).toBe(
      "DM001",
    );
    expect(
      await sqlstateOf(
        as(async (tx) =>
          addFinding(tx, job.id, {
            mechanicId: mechanic,
            description: "x",
            attachmentIds: [await fakeAttachment(tx)],
          }),
        ),
      ),
    ).toBe("DM001");
  });

  it("removed parts and quality checks are recorded only while the job is in work", async () => {
    const job = await jobAt("TESDIQLENDI", "RVWC");
    expect(
      await sqlstateOf(
        as(async (tx) =>
          recordRemovedPart(tx, job.id, {
            description: "Disk",
            photoId: await fakeAttachment(tx),
            disposition: "DISPOSED",
          }),
        ),
      ),
    ).toBe("DM001");
  });

  it("every mechanic named on work rows holds the MECHANIC role (R3)", async () => {
    const job = await jobAt("TEMIRDE", "RVWD");
    expect(
      await sqlstateOf(
        as((tx) => addPlannedService(tx, job.id, { description: "x", mechanicId: formen })),
      ),
    ).toBe("DM005");
    expect(
      await sqlstateOf(
        as(async (tx) =>
          recordRemovedPart(tx, job.id, {
            description: "Disk",
            photoId: await fakeAttachment(tx),
            disposition: "DISPOSED",
            mechanicId: formen,
          }),
        ),
      ),
    ).toBe("DM005");
    expect(await sqlstateOf(as((tx) => assignMechanic(tx, job.id, formen)))).toBe("DM005");
    await as((tx) => assignMechanic(tx, job.id, mechanic));
    const part = await as(async (tx) =>
      recordRemovedPart(tx, job.id, {
        description: "Disk",
        photoId: await fakeAttachment(tx),
        disposition: "RETURNED_TO_CLIENT",
        mechanicId: mechanic,
      }),
    );
    const [row] = await t.db.select().from(removedParts).where(eq(removedParts.id, part));
    expect(row!.mechanicId).toBe(mechanic);
  });

  it("a planned service keeps its text; only the catalog item and mechanic change", async () => {
    const job = await jobAt("QEBUL", "RVWE");
    const id = await as((tx) => addPlannedService(tx, job.id, { description: "Yağ dəyişmə" }));
    const update = (values: Partial<typeof plannedServices.$inferInsert>) =>
      withActor(t.db, { userId: formen, reason: "test" }, (tx) =>
        tx.update(plannedServices).set(values).where(eq(plannedServices.id, id)),
      );
    expect(await sqlstateOf(update({ description: "Başqa iş" }))).toBe("DM005");
    await update({ mechanicId: mechanic });
  });

  it("a finding's evidence is a photo or a video, never a document", async () => {
    const job = await jobAt("QEBUL", "RVWF");
    expect(
      await sqlstateOf(
        as(async (tx) => {
          const [pdf] = await tx
            .insert(attachments)
            .values({
              storageKey: "f".repeat(64),
              sha256: "f".repeat(64),
              mimeType: "application/pdf",
              sizeBytes: 10,
            })
            .returning({ id: attachments.id });
          return addFinding(tx, job.id, {
            mechanicId: mechanic,
            description: "x",
            attachmentIds: [pdf!.id],
          });
        }),
      ),
    ).toBe("DM005");
  });
});

describe("corrections to findings (spec 01, 3.6)", () => {
  it("are new rows with a reason, pointing at a finding of the same job", async () => {
    const job = await jobAt("QEBUL", "RVWG");
    const other = await jobAt("QEBUL", "RVWH");
    const original = await as(async (tx) =>
      addFinding(tx, job.id, {
        mechanicId: mechanic,
        description: "Ön əyləc",
        attachmentIds: [await fakeAttachment(tx)],
      }),
    );
    await walk(t.db, formen, job.id, ["BAXIS"]);
    const input = async (tx: Tx) => ({
      description: "Arxa əyləc",
      mechanicId: mechanic,
      attachmentIds: [await fakeAttachment(tx)],
    });

    await expect(
      as(async (tx) => correctFinding(tx, original, await input(tx), " ")),
    ).rejects.toBeInstanceOf(ClientInputError);
    const fixed = await as(async (tx) =>
      correctFinding(tx, original, await input(tx), "Səhv təkər yazılıb"),
    );
    const [row] = await t.db
      .select()
      .from(inspectionFindings)
      .where(eq(inspectionFindings.id, fixed));
    expect(row).toMatchObject({ correctsId: original, correctionReason: "Səhv təkər yazılıb" });

    // Bypassing lib: no reason, or a finding of another job.
    expect(
      await sqlstateOf(
        as((tx) =>
          tx.insert(inspectionFindings).values({
            jobOrderId: job.id,
            mechanicId: mechanic,
            description: "x",
            correctsId: original,
          }),
        ),
      ),
    ).toBe("23514");
    expect(
      await sqlstateOf(
        as(async (tx) => {
          const [f] = await tx
            .insert(inspectionFindings)
            .values({
              jobOrderId: other.id,
              mechanicId: mechanic,
              description: "x",
              correctsId: original,
              correctionReason: "y",
            })
            .returning({ id: inspectionFindings.id });
          await tx
            .insert(inspectionFindingAttachments)
            .values({ findingId: f!.id, attachmentId: await fakeAttachment(tx) });
        }),
      ),
    ).toBe("DM005");
  });
});

describe("intake records (R8, AC8)", () => {
  async function input(vehicleId: string, km: number, userId = formen): Promise<ReceiveInput> {
    return as(async (tx) => {
      const photos = {} as ReceiveInput["photos"];
      for (const slot of INTAKE_SLOTS) photos[slot] = await fakeAttachment(tx);
      return {
        vehicleId,
        contragentId: client,
        formenId: formen,
        photos,
        odometer: { valueKm: km },
        confirmation: {
          signerName: "Sürücü",
          signerPhone: "+994551112233",
          signatureAttachmentId: await fakeAttachment(tx),
        },
        vinCheck: "NEW_VEHICLE",
      };
    }, userId);
  }

  it("the VIN check is recorded, and every row is the PIN holder's", async () => {
    const car = await newVehicle(t.db, formen, "RVWJ");
    const saved = await as(async (tx) => receiveVehicle(tx, await input(car.id, 1000)));
    const [confirmation] = await t.db
      .select({ vinCheck: intakeConfirmations.vinCheck })
      .from(intakeConfirmations)
      .where(eq(intakeConfirmations.jobOrderId, saved.jobId));
    expect(confirmation!.vinCheck).toBe("NEW_VEHICLE");

    // AC8: every intake row, and its audit entry, names the signed-in formen.
    const rowsOf: [string, string, string][] = [
      ["job_orders", "id", saved.jobId],
      ["intake_photos", "job_order_id", saved.jobId],
      ["odometer_readings", "job_order_id", saved.jobId],
      ["intake_confirmations", "job_order_id", saved.jobId],
      ["qr_stickers", "vehicle_id", car.id],
    ];
    for (const [table, column, value] of rowsOf) {
      const { rows } = await t.migratorPool.query(
        `SELECT DISTINCT r.created_by, a.user_id FROM "${table}" r
           JOIN audit_log a ON a.table_name = $1 AND a.record_id = r.id
          WHERE r."${column}" = $2`,
        [table, value],
      );
      expect(rows, table).toEqual([{ created_by: formen, user_id: formen }]);
    }
  });

  it("intake photos are this formen's own uploads", async () => {
    const car = await newVehicle(t.db, formen, "RVWK");
    // Photos uploaded by another formen cannot be passed off as this intake's.
    const theirs = await input(car.id, 1000, otherFormen);
    await expect(as((tx) => receiveVehicle(tx, theirs))).rejects.toBeInstanceOf(
      IntakePhotoReusedError,
    );
  });
});

describe("sticker reprints (R8)", () => {
  it("a label printed before sticker rows existed still warns after a reprint", async () => {
    const car = await newVehicle(t.db, formen, "RVWL");
    const [{ qr_token: old }] = (
      await t.db.execute<{ qr_token: string }>(
        sql`SELECT qr_token FROM vehicles WHERE id = ${car.id}`,
      )
    ).rows as [{ qr_token: string }];
    const fresh = await as((tx) => reprintSticker(tx, car.id, "Köhnə stiker"));
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(await findByQrToken(t.db, old)).toEqual({ vehicleId: car.id, replaced: true });
    expect(await findByQrToken(t.db, fresh)).toEqual({ vehicleId: car.id, replaced: false });
  });
});
