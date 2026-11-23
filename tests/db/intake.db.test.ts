// Plan 04, proof: receiving a car and the formen's steps up to handover (spec 01), with
// the preconditions the database enforces (job_orders_intake_guard, migration 0026).
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inspectionFindings,
  intakeConfirmations,
  intakePhotos,
  jobOrders,
  odometerReadings,
  partsRequests,
  qrStickers,
} from "@/db/schema";
import { withActor } from "@/lib/audit";
import { addVehicle, createContract } from "@/lib/contracts";
import { createDraft, submitDocument } from "@/lib/documents";
import {
  addFinding,
  addPartsRequest,
  findByQrToken,
  handOver,
  INTAKE_SLOTS,
  IntakePhotoReusedError,
  OdometerReasonRequiredError,
  OwnerQuestionRequiredError,
  qualityCheck,
  qualityChecklist,
  receiveVehicle,
  reprintSticker,
  startWork,
  type ReceiveInput,
} from "@/lib/intake";
import { ContractDecisionRequiredError, moveJob, openJob } from "@/lib/jobs";
import { recordPlate } from "@/lib/vehicles";
import { odometerAlerts } from "@/lib/intake/queries";
import { createUser } from "./fixtures";
import { createTestDb, sqlstateOf, type TestDb } from "./helpers";
import { fakeAttachment, newClient, newJob, newVehicle, PATH_TO, walk } from "./jobs-fixtures";

let t: TestDb;
let formen: string;
let mechanic: string;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  // Walks the warehouse and approval steps too, so it holds OWNER besides FORMEN.
  formen = await createUser(t.migratorPool, { roles: ["FORMEN", "OWNER"] });
  mechanic = await createUser(t.migratorPool, { roles: ["MECHANIC"] });
  client = await newClient(t.db, formen);
});
afterAll(() => t.close());

const as = <T>(fn: (tx: Parameters<Parameters<typeof withActor>[2]>[0]) => Promise<T>) =>
  withActor(t.db, { userId: formen }, fn);

/** Everything receiveVehicle needs, with fresh attachments. */
async function intakeInput(
  vehicleId: string,
  km: number,
  extra: Partial<ReceiveInput> = {},
): Promise<ReceiveInput> {
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
      vinCheck: "LAST6_CONFIRMED",
      ...extra,
    };
  });
}

async function statusOf(jobId: string) {
  const [j] = await t.db
    .select({ status: jobOrders.status })
    .from(jobOrders)
    .where(eq(jobOrders.id, jobId));
  return j!.status;
}

describe("AC3: a job leaves QEBUL only with six photos, an odometer reading and a confirmation", () => {
  it("the database refuses BAXIS until all three exist", async () => {
    const car = await newVehicle(t.db, formen, "XNTKA");
    const job = await as((tx) =>
      openJob(tx, { vehicleId: car.id, contragentId: client, formenId: formen }),
    );
    const toBaxis = () => as((tx) => moveJob(tx, job.id, "BAXIS", "test"));

    expect(await sqlstateOf(toBaxis())).toBe("DM006");
    const odometerPhoto = await as(async (tx) => {
      const ids: string[] = [];
      for (const slot of INTAKE_SLOTS) {
        const id = await fakeAttachment(tx);
        ids.push(id);
        await tx.insert(intakePhotos).values({ jobOrderId: job.id, slot, attachmentId: id });
      }
      return ids[0]!;
    });
    expect(await sqlstateOf(toBaxis())).toBe("DM006");
    await as((tx) =>
      tx
        .insert(odometerReadings)
        .values({ vehicleId: car.id, jobOrderId: job.id, valueKm: 5000, photoId: odometerPhoto }),
    );
    expect(await sqlstateOf(toBaxis())).toBe("DM006");
    await as(async (tx) =>
      tx.insert(intakeConfirmations).values({
        jobOrderId: job.id,
        method: "SIGNATURE",
        signerName: "Sürücü",
        signerPhone: "+994551112233",
        signatureAttachmentId: await fakeAttachment(tx),
        vinCheck: "LAST6_CONFIRMED",
      }),
    );
    await toBaxis();
    expect(await statusOf(job.id)).toBe("BAXIS");
  });

  it("receiveVehicle needs every photo, and a confirmation by signature needs the signature", async () => {
    const car = await newVehicle(t.db, formen, "XNTKB");
    const input = await intakeInput(car.id, 1000);
    const fivePhotos: Partial<ReceiveInput["photos"]> = { ...input.photos };
    delete fivePhotos.DASHBOARD;
    await expect(
      as((tx) => receiveVehicle(tx, { ...input, photos: fivePhotos as ReceiveInput["photos"] })),
    ).rejects.toThrow(/DASHBOARD photo is missing/);
    const unsigned = { ...input.confirmation, signatureAttachmentId: null as unknown as string };
    expect(
      await sqlstateOf(as((tx) => receiveVehicle(tx, { ...input, confirmation: unsigned }))),
    ).toBe("23514");
  });

  it("a photo is evidence for one job only", async () => {
    const car = await newVehicle(t.db, formen, "XNTKC");
    const input = await intakeInput(car.id, 1000);
    await expect(
      as((tx) =>
        receiveVehicle(tx, { ...input, photos: { ...input.photos, REAR: input.photos.FRONT } }),
      ),
    ).rejects.toBeInstanceOf(IntakePhotoReusedError);

    await as((tx) => receiveVehicle(tx, input));
    // Another car's intake with the same files (checked before anything is written).
    const other = await newVehicle(t.db, formen, "XNTKCC");
    const again = await intakeInput(other.id, 1100);
    await expect(
      as((tx) => receiveVehicle(tx, { ...again, photos: input.photos })),
    ).rejects.toBeInstanceOf(IntakePhotoReusedError);
  });
});

describe("AC4: the odometer", () => {
  it("lower than the last reading needs a reason and is flagged", async () => {
    const car = await newVehicle(t.db, formen, "XNTKD");
    const first = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 150_000)));
    await walk(t.db, formen, first.jobId, [...PATH_TO.TEMIRDE, "HAZIR", "TEHVIL_VERILDI"]);

    const lower = await intakeInput(car.id, 140_000);
    await expect(as((tx) => receiveVehicle(tx, lower))).rejects.toBeInstanceOf(
      OdometerReasonRequiredError,
    );
    const saved = await as((tx) =>
      receiveVehicle(tx, { ...lower, odometer: { valueKm: 140_000, reason: "Panel dəyişib" } }),
    );
    expect(saved.belowPrevious).toBe(true);
    const [reading] = await t.db
      .select()
      .from(odometerReadings)
      .where(eq(odometerReadings.jobOrderId, saved.jobId));
    expect(reading).toMatchObject({ belowPrevious: true, reason: "Panel dəyişib" });
    // The owner sees it on the home page until messages are sent (B6).
    expect(await odometerAlerts(t.db)).toContainEqual(
      expect.objectContaining({ jobId: saved.jobId, belowPrevious: true, reason: "Panel dəyişib" }),
    );
  });

  it("the database itself refuses a lower reading without a reason", async () => {
    const car = await newVehicle(t.db, formen, "XNTKE");
    const first = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 80_000)));
    await walk(t.db, formen, first.jobId, [...PATH_TO.TEMIRDE, "HAZIR", "TEHVIL_VERILDI"]);
    const job = await as((tx) =>
      openJob(tx, { vehicleId: car.id, contragentId: client, formenId: formen }),
    );
    expect(
      await sqlstateOf(
        as(async (tx) =>
          tx.insert(odometerReadings).values({
            vehicleId: car.id,
            jobOrderId: job.id,
            valueKm: 70_000,
            photoId: await fakeAttachment(tx),
            // A client cannot clear the flag: the trigger sets it.
            belowPrevious: false,
          }),
        ),
      ),
    ).toBe("23514");
  });

  it("a jump above the daily limit since the last visit is flagged", async () => {
    const car = await newVehicle(t.db, formen, "XNTKF");
    const first = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 10_000)));
    await walk(t.db, formen, first.jobId, [...PATH_TO.TEMIRDE, "HAZIR", "TEHVIL_VERILDI"]);
    // Same day: at most 1 000 km (the default setting) is normal.
    const second = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 12_500)));
    expect(second).toMatchObject({ belowPrevious: false, aboveDailyLimit: true });
  });
});

describe("AC5: a corporate car not on its contract", () => {
  it("needs the formen's decision, which is stored and logged", async () => {
    const owner = await createUser(t.migratorPool, { roles: ["MANAGEMENT"] });
    const company = await newClient(t.db, formen, "HUQUQI", "Korporativ MMC");
    const onContract = await newVehicle(t.db, formen, "XNTKG");
    const notOnContract = await newVehicle(t.db, formen, "XNTKH");
    await withActor(t.db, { userId: owner }, async (tx) => {
      const id = await createContract(tx, {
        contragentId: company,
        number: "K-7",
        signedOn: "2026-01-01",
        validFrom: "2026-01-01",
      });
      await addVehicle(tx, id, onContract.id);
    });

    const input = await intakeInput(notOnContract.id, 3000, { contragentId: company });
    await expect(as((tx) => receiveVehicle(tx, input))).rejects.toBeInstanceOf(
      ContractDecisionRequiredError,
    );
    const saved = await as((tx) =>
      receiveVehicle(tx, { ...input, contractDecision: "SEPARATE_PAID" }),
    );
    expect(saved.contractCheck).toBe("NOT_ON_CONTRACT");
    const { rows } = await t.migratorPool.query(
      `SELECT user_id, after->>'contract_decision' AS decision FROM audit_log
        WHERE table_name = 'job_orders' AND record_id = $1 AND action = 'INSERT'`,
      [saved.jobId],
    );
    expect(rows).toEqual([{ user_id: formen, decision: "SEPARATE_PAID" }]);
  });
});

describe("the owner question (spec 00, 3a)", () => {
  it("a different client from the last visit must be answered, and the answer is kept", async () => {
    const car = await newVehicle(t.db, formen, "XNTKJ");
    const first = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 1000)));
    await walk(t.db, formen, first.jobId, [...PATH_TO.TEMIRDE, "HAZIR", "TEHVIL_VERILDI"]);

    const buyer = await newClient(t.db, formen, "FIZIKI", "Yeni Sahib");
    const input = await intakeInput(car.id, 2000, { contragentId: buyer });
    await expect(as((tx) => receiveVehicle(tx, input))).rejects.toBeInstanceOf(
      OwnerQuestionRequiredError,
    );
    const saved = await as((tx) => receiveVehicle(tx, { ...input, ownerChanged: true }));
    const [job] = await t.db
      .select({ ownerChanged: jobOrders.ownerChanged })
      .from(jobOrders)
      .where(eq(jobOrders.id, saved.jobId));
    expect(job!.ownerChanged).toBe(true);
  });
});

describe("AC6: findings", () => {
  it("each has a mechanic and at least one attachment", async () => {
    const car = await newVehicle(t.db, formen, "XNTKK");
    const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    await expect(
      as((tx) =>
        addFinding(tx, job.id, { mechanicId: mechanic, description: "Səs", attachmentIds: [] }),
      ),
    ).rejects.toThrow(/at least one photo/);
    // Bypassing lib: the deferred trigger refuses at commit.
    expect(
      await sqlstateOf(
        as((tx) =>
          tx
            .insert(inspectionFindings)
            .values({ jobOrderId: job.id, mechanicId: mechanic, description: "Səs" }),
        ),
      ),
    ).toBe("DM005");
    // The mechanic must be a mechanic.
    expect(
      await sqlstateOf(
        as(async (tx) =>
          addFinding(tx, job.id, {
            mechanicId: formen,
            description: "Səs",
            attachmentIds: [await fakeAttachment(tx)],
          }),
        ),
      ),
    ).toBe("DM005");
  });

  it("are edited only in QEBUL; after Anbara göndər they are only added", async () => {
    const car = await newVehicle(t.db, formen, "XNTKL");
    const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    const finding = await as(async (tx) =>
      addFinding(tx, job.id, {
        mechanicId: mechanic,
        description: "Əyləc",
        attachmentIds: [await fakeAttachment(tx)],
      }),
    );
    const edit = (text: string) =>
      withActor(t.db, { userId: formen, reason: "düzəliş" }, (tx) =>
        tx
          .update(inspectionFindings)
          .set({ description: text })
          .where(eq(inspectionFindings.id, finding)),
      );
    await edit("Ön əyləc");
    await walk(t.db, formen, job.id, ["BAXIS"]);
    expect(await sqlstateOf(edit("Arxa əyləc"))).toBe("DM005");
    await as(async (tx) =>
      addFinding(tx, job.id, {
        mechanicId: mechanic,
        description: "Arxa əyləc də",
        attachmentIds: [await fakeAttachment(tx)],
      }),
    );
  });
});

describe("workshop preconditions", () => {
  async function jobInWork() {
    const car = await newVehicle(t.db, formen, "XNTKM");
    const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    await walk(t.db, formen, job.id, PATH_TO.TEMIRDE);
    return job.id;
  }
  const passAll = async (tx: Parameters<Parameters<typeof withActor>[2]>[0]) =>
    Object.fromEntries((await qualityChecklist(tx)).map((i) => [i, true]));

  it("TEMIRDE waits until every parts request is settled (B8)", async () => {
    const car = await newVehicle(t.db, formen, "XNTKN");
    const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    const part = await as((tx) =>
      addPartsRequest(tx, job.id, { description: "Filtr", quantity: "1" }),
    );
    await walk(t.db, formen, job.id, PATH_TO.TESDIQLENDI);
    expect(await sqlstateOf(as((tx) => startWork(tx, job.id)))).toBe("DM006");
    await withActor(t.db, { userId: formen, reason: "anbarda yoxdur" }, (tx) =>
      tx.update(partsRequests).set({ status: "CANCELLED" }).where(eq(partsRequests.id, part)),
    );
    await as((tx) => startWork(tx, job.id));
    expect(await statusOf(job.id)).toBe("TEMIRDE");
  });

  it("HAZIR needs a passed quality check made since the job last entered TEMIRDE", async () => {
    const jobId = await jobInWork();
    expect(await sqlstateOf(as((tx) => moveJob(tx, jobId, "HAZIR", "test")))).toBe("DM006");

    const failed = await as(async (tx) =>
      qualityCheck(tx, jobId, {
        items: { ...(await passAll(tx)), CAR_CLEAN: false },
        dashboardPhotoId: await fakeAttachment(tx),
        mechanicId: mechanic,
      }),
    );
    expect(failed).toBe(false);
    expect(await statusOf(jobId)).toBe("TEMIRDE");

    await walk(t.db, formen, jobId, ["HAZIR"]);
    expect(await statusOf(jobId)).toBe("HAZIR");
    // Back to work: the earlier check no longer counts.
    await as((tx) => moveJob(tx, jobId, "TEMIRDE", "yoxlamadan keçmədi"));
    expect(await sqlstateOf(as((tx) => moveJob(tx, jobId, "HAZIR", "test")))).toBe("DM006");
  });

  it("TEHVIL_VERILDI needs a numbered Təhvil-Təslim aktı with a signature", async () => {
    const jobId = await jobInWork();
    await walk(t.db, formen, jobId, ["HAZIR"]);
    expect(await sqlstateOf(as((tx) => moveJob(tx, jobId, "TEHVIL_VERILDI", "test")))).toBe(
      "DM006",
    );
    // An act without a signature does not count.
    await as(async (tx) => {
      const id = await createDraft(tx, { type: "TEHVIL_TESLIM", jobOrderId: jobId });
      await submitDocument(tx, id);
    });
    expect(await sqlstateOf(as((tx) => moveJob(tx, jobId, "TEHVIL_VERILDI", "test")))).toBe(
      "DM006",
    );
    const result = await as(async (tx) =>
      handOver(tx, jobId, {
        signerName: "Alan",
        signerPhone: "+994551112244",
        signatureAttachmentId: await fakeAttachment(tx),
      }),
    );
    expect(result.status).toBe("TEHVIL_VERILDI");
    expect(result.number).toMatch(/^[A-Z]+-\d{4}-\d{6}$/);
  });
});

describe("QR stickers (spec 01, section 4)", () => {
  it("a new car gets a sticker; a reprint replaces it, and the old one still resolves with a warning", async () => {
    const car = await newVehicle(t.db, formen, "XNTKP");
    const saved = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 500)));
    const old = saved.newStickerToken!;
    expect(old).toMatch(/^[0-9a-f]{32}$/);
    expect(await findByQrToken(t.db, old)).toEqual({ vehicleId: car.id, replaced: false });

    await expect(as((tx) => reprintSticker(tx, car.id, " "))).rejects.toThrow(/reason/);
    const fresh = await as((tx) => reprintSticker(tx, car.id, "Stiker cırılıb"));
    expect(fresh).not.toBe(old);
    expect(await findByQrToken(t.db, fresh)).toEqual({ vehicleId: car.id, replaced: false });
    expect(await findByQrToken(t.db, old)).toEqual({ vehicleId: car.id, replaced: true });

    // A replaced sticker stays replaced.
    expect(
      await sqlstateOf(
        withActor(t.db, { userId: formen, reason: "geri" }, (tx) =>
          tx.update(qrStickers).set({ status: "ACTIVE" }).where(eq(qrStickers.qrToken, old)),
        ),
      ),
    ).toBe("DM005");
    // A returning car does not get another sticker at intake.
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM qr_stickers WHERE vehicle_id = ${car.id}`,
    );
    expect(rows[0]!.n).toBe(2);
  });
});

describe("AC1a: the plate is history, not a key", () => {
  it("a plate change keeps the job's snapshot and the car's history", async () => {
    const car = await newVehicle(t.db, formen, "XNTKR", "10-AA-111");
    const first = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 700)));
    await walk(t.db, formen, first.jobId, [...PATH_TO.TEMIRDE, "HAZIR", "TEHVIL_VERILDI"]);
    await as((tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "77-ZZ-777", source: "INTAKE" }),
    );
    const second = await as(async (tx) => receiveVehicle(tx, await intakeInput(car.id, 900)));
    const snapshots = await t.db
      .select({ id: jobOrders.id, plate: jobOrders.plateSnapshot })
      .from(jobOrders)
      .where(eq(jobOrders.vehicleId, car.id))
      .orderBy(jobOrders.createdAt);
    expect(snapshots).toEqual([
      { id: first.jobId, plate: "10-AA-111" },
      { id: second.jobId, plate: "77-ZZ-777" },
    ]);
  });
});
