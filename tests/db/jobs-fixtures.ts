import { sql } from "drizzle-orm";
import { contragents } from "@/db/schema";
import { withActor } from "@/lib/audit";
import type { Db } from "@/lib/db/types";
import { moveJob, openJob, type JobStatus, type OpenJobInput } from "@/lib/jobs";
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
  return withActor(db, { userId }, (tx) => openJob(tx, { formenId: userId, ...input }));
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

export async function walk(db: Db, userId: string, jobId: string, statuses: JobStatus[]) {
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
