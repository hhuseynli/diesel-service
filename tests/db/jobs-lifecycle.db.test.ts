// Plan 02, P6: the job order lifecycle (spec 00, section 4) enforced by the database.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobOrders } from "@/db/schema";
import { withActor } from "@/lib/audit";
import {
  DocumentLockedError,
  ImmutableError,
  InvalidTransitionError,
  pgErrorOf,
} from "@/lib/db/errors";
import {
  cancelJob,
  JOB_STATUSES,
  jobHistory,
  moveJob,
  OpenJobExistsError,
  type JobStatus,
} from "@/lib/jobs";
import { recordPlate } from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { asActor, createTestDb, sqlstateOf, type TestDb } from "./helpers";
import { newClient, newJob, newVehicle, PATH_TO, walk } from "./jobs-fixtures";

let t: TestDb;
let formen: string;
let cashier: string;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  formen = await createUser(t.migratorPool, { roles: ["FORMEN"] });
  cashier = await createUser(t.migratorPool, { roles: ["CASHIER"] });
  client = await newClient(t.db, formen);
});
afterAll(() => t.close());

async function jobAt(status: keyof typeof PATH_TO) {
  const car = await newVehicle(t.db, formen, "JBLFE", "10-LC-001");
  const job = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
  await walk(t.db, formen, job.id, PATH_TO[status]);
  return { ...job, vehicle: car };
}

async function statusOf(jobId: string): Promise<string> {
  const { rows } = await t.migratorPool.query("SELECT status FROM job_orders WHERE id = $1", [
    jobId,
  ]);
  return rows[0].status;
}

const ALLOWED: Record<string, JobStatus[]> = {
  QEBUL: ["BAXIS", "LEGV"],
  BAXIS: ["QIYMETLENDIRME", "LEGV"],
  QIYMETLENDIRME: ["TESDIQ_GOZLEYIR", "LEGV"],
  TESDIQ_GOZLEYIR: ["TESDIQLENDI", "QIYMETLENDIRME", "LEGV"],
  TESDIQLENDI: ["HISSE_GOZLEYIR", "TEMIRDE", "LEGV"],
  HISSE_GOZLEYIR: ["TEMIRDE", "LEGV"],
  TEMIRDE: ["HAZIR", "HISSE_GOZLEYIR", "LEGV"],
  HAZIR: ["TEMIRDE", "ODENILDI", "TEHVIL_VERILDI", "LEGV"],
  // From here the second of payment/handover is allowed; BAGLANDI only after both.
  ODENILDI: ["TEHVIL_VERILDI"],
  TEHVIL_VERILDI: ["ODENILDI"],
};

describe("happy paths close automatically", () => {
  it.each([
    ["paid first", "ODENILDI", "TEHVIL_VERILDI"],
    ["handed over first (deferred payment)", "TEHVIL_VERILDI", "ODENILDI"],
  ] as const)("%s", async (_, first, second) => {
    const job = await jobAt("HAZIR");
    expect(
      await withActor(t.db, { userId: cashier }, (tx) => moveJob(tx, job.id, first, "test")),
    ).toBe(first);
    expect(
      await withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, second, "test")),
    ).toBe("BAGLANDI");
    expect(await statusOf(job.id)).toBe("BAGLANDI");

    const history = await jobHistory(t.db, job.id);
    expect(history.map((e) => e.toStatus)).toEqual([
      "QEBUL",
      ...PATH_TO.HAZIR,
      first,
      second,
      "BAGLANDI",
    ]);
    expect(history[0]).toMatchObject({
      fromStatus: null,
      userId: formen,
      reason: "audit.jobOpened",
    });
    expect(history.at(-3)).toMatchObject({ toStatus: first, userId: cashier, reason: "test" });
    expect(history.at(-1)).toMatchObject({
      fromStatus: second,
      toStatus: "BAGLANDI",
      userId: formen,
      reason: "audit.jobClosed",
    });
    for (const [i, e] of history.entries()) {
      if (i > 0) expect(e.fromStatus).toBe(history[i - 1]!.toStatus);
    }
  });
});

describe("only the transitions in the table exist", () => {
  it.each(Object.keys(ALLOWED))("from %s", async (from) => {
    const job = await jobAt(from as keyof typeof PATH_TO);
    for (const to of JOB_STATUSES) {
      if (to === from || ALLOWED[from]!.includes(to)) continue;
      const set = to === "LEGV" ? { status: to, cancelReason: "x" } : { status: to };
      await expect(
        withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
          tx.update(jobOrders).set(set).where(eq(jobOrders.id, job.id)),
        ),
        `${from} -> ${to}`,
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    }
    expect(await statusOf(job.id)).toBe(from);
  });

  it.each([
    ["TESDIQ_GOZLEYIR", "QIYMETLENDIRME", "Müştəri dəyişiklik istədi"],
    ["HAZIR", "TEMIRDE", "Keyfiyyət yoxlaması keçmədi"],
    ["TEMIRDE", "HISSE_GOZLEYIR", "Hissə çatışmır"],
  ] as const)("the backward step %s -> %s works with a reason", async (from, to, reason) => {
    const job = await jobAt(from);
    await withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, to, reason));
    expect(await statusOf(job.id)).toBe(to);
    expect((await jobHistory(t.db, job.id)).at(-1)).toMatchObject({ fromStatus: from, reason });
    await expect(
      withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, from, " ")),
    ).rejects.toThrow(/reason/);
  });
});

describe("cancelling (LEGV)", () => {
  it.each(["QEBUL", "TESDIQ_GOZLEYIR", "HAZIR"] as const)("is possible from %s", async (from) => {
    const job = await jobAt(from);
    await withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, job.id, "Müştəri imtina etdi"));
    expect(await statusOf(job.id)).toBe("LEGV");
    expect((await jobHistory(t.db, job.id)).at(-1)).toMatchObject({
      toStatus: "LEGV",
      reason: "Müştəri imtina etdi",
    });
  });

  it.each(["ODENILDI", "TEHVIL_VERILDI"] as const)("is refused from %s", async (from) => {
    const job = await jobAt(from);
    await expect(
      withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, job.id, "gec")),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("needs a reason, in code and in the database", async () => {
    const job = await jobAt("QEBUL");
    await expect(
      withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, job.id, "  ")),
    ).rejects.toThrow(/reason/);
    const error = await withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
      tx.update(jobOrders).set({ status: "LEGV" }).where(eq(jobOrders.id, job.id)),
    ).catch((e: unknown) => e);
    expect(pgErrorOf(error)).toMatchObject({
      code: "23514",
      constraint: "job_orders_cancel_reason",
    });
  });
});

describe("closed and cancelled jobs are frozen", () => {
  it("BAGLANDI cannot be reached without both payment and handover", async () => {
    const job = await jobAt("TEHVIL_VERILDI");
    await expect(
      withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
        tx.update(jobOrders).set({ status: "BAGLANDI" }).where(eq(jobOrders.id, job.id)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("a terminal job cannot change at all, even through the owner role", async () => {
    const closed = await jobAt("HAZIR");
    await walk(t.db, formen, closed.id, ["ODENILDI", "TEHVIL_VERILDI"]);
    const cancelled = await jobAt("QEBUL");
    await withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, cancelled.id, "səhv"));
    for (const id of [closed.id, cancelled.id]) {
      await expect(
        withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
          tx.update(jobOrders).set({ complaints: "dəyişdi" }).where(eq(jobOrders.id, id)),
        ),
      ).rejects.toBeInstanceOf(DocumentLockedError);
      expect(
        await sqlstateOf(
          asActor(t.migratorPool, { userId: formen, reason: "x" }, (c) =>
            c.query("UPDATE job_orders SET complaints = 'x' WHERE id = $1", [id]),
          ),
        ),
      ).toBe("DM001");
    }
  });
});

describe("integrity", () => {
  it("the app cannot write job_status_events", async () => {
    const job = await jobAt("QEBUL");
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId: formen }, (c) =>
          c.query(
            "INSERT INTO job_status_events (job_order_id, to_status, user_id) VALUES ($1, 'BAGLANDI', $2)",
            [job.id, formen],
          ),
        ),
      ),
    ).toBe("42501");
  });

  it("number, vehicle and snapshots cannot change", async () => {
    const job = await jobAt("BAXIS");
    const other = await newVehicle(t.db, formen, "JBLFE");
    for (const set of [
      { number: "IS-2026-999999" },
      { vehicleId: other.id },
      { plateSnapshot: "FAKE" },
    ]) {
      await expect(
        withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
          tx.update(jobOrders).set(set).where(eq(jobOrders.id, job.id)),
        ),
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });

  it("snapshots come from the database and keep the plate the car arrived with", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE", "77-SN-001");
    const [{ id }] = (
      await asActor(t.appPool, { userId: formen }, (c) =>
        c.query(
          `INSERT INTO job_orders (number, vehicle_id, contragent_id, contract_check, formen_id, vin_snapshot, plate_snapshot)
           VALUES ('IS-2000-000001', $1, $2, 'NO_CONTRACT', $3, 'FAKEVIN', 'FAKE') RETURNING id`,
          [car.id, client, formen],
        ),
      )
    ).rows;
    await withActor(t.db, { userId: formen }, (tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "77-SN-002", source: "INTAKE" }),
    );
    const { rows } = await t.migratorPool.query(
      "SELECT vin_snapshot, plate_snapshot FROM job_orders WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ vin_snapshot: car.vin, plate_snapshot: "77-SN-001" });
  });

  it("a new job must start in QEBUL", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE");
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId: formen }, (c) =>
          c.query(
            `INSERT INTO job_orders (number, vehicle_id, contragent_id, contract_check, formen_id, status)
             VALUES ('IS-2000-000002', $1, $2, 'NO_CONTRACT', $3, 'TEMIRDE')`,
            [car.id, client, formen],
          ),
        ),
      ),
    ).toBe("DM006");
  });
});

describe("one open job per car, gapless job numbers", () => {
  it("a second open job is refused; after closing or cancelling a new one opens", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE");
    const first = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    await expect(newJob(t.db, formen, { vehicleId: car.id, contragentId: client })).rejects.toEqual(
      new OpenJobExistsError(first.id),
    );
    // The database refuses it too, whatever the app does.
    const error = await asActor(t.appPool, { userId: formen }, (c) =>
      c.query(
        `INSERT INTO job_orders (number, vehicle_id, contragent_id, contract_check, formen_id)
         VALUES ('IS-2000-000003', $1, $2, 'NO_CONTRACT', $3)`,
        [car.id, client, formen],
      ),
    ).catch((e: unknown) => e);
    expect(pgErrorOf(error)).toMatchObject({
      code: "23505",
      constraint: "job_orders_one_open_per_vehicle",
    });

    await withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, first.id, "səhv maşın"));
    const second = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    expect(second.number).not.toBe(first.number);
  });

  it("concurrent opens get consecutive IS numbers; no number is skipped", async () => {
    const cars = [];
    for (let i = 0; i < 20; i++) cars.push(await newVehicle(t.db, formen, "JBCNC"));
    await Promise.all(
      cars.map((car) => newJob(t.db, formen, { vehicleId: car.id, contragentId: client })),
    );
    const { rows } = await t.db.execute<{ number: string }>(
      sql`SELECT number FROM job_orders WHERE number LIKE 'IS-' || extract(year FROM baku_date())::int || '-%'`,
    );
    const sequences = rows.map((r) => Number(r.number.slice(-6))).sort((a, b) => a - b);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
    expect(sequences.length).toBeGreaterThanOrEqual(20);
  });
});
