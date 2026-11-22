import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { attachments, contragents, documentSignatures } from "@/db/schema";
import { withActor } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db/types";
import { createDraft, submitDocument } from "@/lib/documents";
import {
  handOver,
  INTAKE_SLOTS,
  qualityCheck,
  qualityChecklist,
  receiveVehicle,
} from "@/lib/intake";
import { moveJob, type JobStatus, type OpenJobInput } from "@/lib/jobs";
import { createVehicle } from "@/lib/vehicles";

let vinCounter = 0;

/** A new vehicle with a unique VIN; `prefix` keeps VINs distinct between test files. */
export async function newVehicle(db: Db, userId: string, prefix: string, plate?: string) {
  const vin = `${prefix}${String(++vinCounter).padStart(17 - prefix.length, "0")}`;
  const { id } = await withActor(db, { userId }, (tx) =>
    createVehicle(tx, { vin, plate: plate ? { display: plate, source: "INTAKE" } : undefined }),
  );
  return { id, vin };
}

export async function newClient(
  db: Db,
  userId: string,
  kind: "FIZIKI" | "HUQUQI" = "FIZIKI",
  name = "Test Müştəri",
): Promise<string> {
  const [row] = await withActor(db, { userId }, (tx) =>
    tx
      .insert(contragents)
      .values({ kind, name, isCustomer: true })
      .returning({ id: contragents.id }),
  );
  return row!.id;
}

export async function newJob(
  db: Db,
  userId: string,
  input: Partial<OpenJobInput> & { vehicleId: string; contragentId: string },
) {
  // A job arrives the way the tablet makes it: six photos, odometer, confirmation (plan 04).
  return withActor(db, { userId }, async (tx) => {
    const photos = Object.fromEntries(
      await Promise.all(INTAKE_SLOTS.map(async (slot) => [slot, await fakeAttachment(tx)])),
    ) as Record<(typeof INTAKE_SLOTS)[number], string>;
    const received = await receiveVehicle(tx, {
      formenId: userId,
      ownerChanged: false,
      ...input,
      photos,
      odometer: { valueKm: (odometerKm += 1000) },
      confirmation: {
        signerName: "Test Sürücü",
        signerPhone: "+994551112233",
        signatureAttachmentId: await fakeAttachment(tx),
      },
    });
    return { id: received.jobId, number: received.number, contractCheck: received.contractCheck };
  });
}

/** The forward path to each status, from QEBUL. */
export const PATH_TO: Record<Exclude<JobStatus, "BAGLANDI" | "LEGV">, JobStatus[]> = {
  QEBUL: [],
  BAXIS: ["BAXIS"],
  QIYMETLENDIRME: ["BAXIS", "QIYMETLENDIRME"],
  TESDIQ_GOZLEYIR: ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR"],
  TESDIQLENDI: ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "TESDIQLENDI"],
  HISSE_GOZLEYIR: ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "TESDIQLENDI", "HISSE_GOZLEYIR"],
  TEMIRDE: ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "TESDIQLENDI", "TEMIRDE"],
  HAZIR: ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "TESDIQLENDI", "TEMIRDE", "HAZIR"],
  ODENILDI: [
    "BAXIS",
    "QIYMETLENDIRME",
    "TESDIQ_GOZLEYIR",
    "TESDIQLENDI",
    "TEMIRDE",
    "HAZIR",
    "ODENILDI",
  ],
  TEHVIL_VERILDI: [
    "BAXIS",
    "QIYMETLENDIRME",
    "TESDIQ_GOZLEYIR",
    "TESDIQLENDI",
    "TEMIRDE",
    "HAZIR",
    "TEHVIL_VERILDI",
  ],
};

let odometerKm = 10_000;

/** An attachment row with random content, for tests that need evidence but no bytes. */
export async function fakeAttachment(tx: Tx): Promise<string> {
  const hex = randomBytes(32).toString("hex");
  const [row] = await tx
    .insert(attachments)
    .values({ storageKey: hex, sha256: hex, mimeType: "image/jpeg", sizeBytes: 1000 })
    .returning({ id: attachments.id });
  return row!.id;
}

/**
 * Moves a job along `statuses` the way the tablet does: HAZIR through a passed quality
 * check, TEHVIL_VERILDI through a signed Təhvil-Təslim aktı (plan 04).
 */
export async function walk(db: Db, userId: string, jobId: string, statuses: JobStatus[]) {
  for (const status of statuses) {
    if (status === "HAZIR") {
      await withActor(db, { userId }, async (tx) =>
        qualityCheck(tx, jobId, {
          items: Object.fromEntries((await qualityChecklist(tx)).map((i) => [i, true])),
          dashboardPhotoId: await fakeAttachment(tx),
        }),
      );
    } else {
      await step(db, userId, jobId, status, `test: ${status}`);
    }
  }
}

/** A numbered, signed Təhvil-Təslim aktı for the job, without moving the job. */
export async function signedHandoverAct(db: Db, userId: string, jobId: string): Promise<void> {
  await withActor(db, { userId }, async (tx) => {
    const id = await createDraft(tx, { type: "TEHVIL_TESLIM", jobOrderId: jobId });
    await tx.insert(documentSignatures).values({
      documentId: id,
      signerName: "Test Alan",
      signerPhone: "+994551112244",
      signatureAttachmentId: await fakeAttachment(tx),
    });
    await submitDocument(tx, id);
  });
}

/**
 * One step as `userId`, returning where the job ends up: TEHVIL_VERILDI through handOver,
 * anything else through moveJob.
 */
export async function step(
  db: Db,
  userId: string,
  jobId: string,
  to: JobStatus,
  reason = "test",
): Promise<JobStatus> {
  return withActor(db, { userId }, async (tx) => {
    if (to !== "TEHVIL_VERILDI")
      return moveJob(tx, jobId, to as Exclude<JobStatus, "LEGV">, reason);
    const result = await handOver(tx, jobId, {
      signerName: "Test Alan",
      signerPhone: "+994551112244",
      signatureAttachmentId: await fakeAttachment(tx),
    });
    return result.status;
  });
}

/** The previous walk, step by step with no preconditions met (for refusal tests). */
export async function walkRaw(db: Db, userId: string, jobId: string, statuses: JobStatus[]) {
  for (const status of statuses) {
    await withActor(db, { userId }, (tx) =>
      moveJob(tx, jobId, status as Exclude<JobStatus, "LEGV">, `test: ${status}`),
    );
  }
}

/** Today, yesterday and tomorrow in Asia/Baku, from the database clock. */
export async function bakuDays(db: Db) {
  const { rows } = await db.execute<{ today: string; yesterday: string; tomorrow: string }>(sql`
    SELECT baku_date()::text AS today, (baku_date() - 1)::text AS yesterday,
           (baku_date() + 1)::text AS tomorrow`);
  return rows[0]!;
}
