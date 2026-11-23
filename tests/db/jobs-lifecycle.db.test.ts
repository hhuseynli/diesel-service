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
  ReasonRequiredError,
} from "@/lib/db/errors";
import { createContract } from "@/lib/contracts";
import {
  cancelJob,
  JOB_STATUSES,
  jobHistory,
  moveJob,
  openJob,
  OpenJobExistsError,
  resolveHold,
  type JobStatus,
} from "@/lib/jobs";
import { assignNumber } from "@/lib/numbering";
import { recordPlate } from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { asActor, createTestDb, sqlstateOf, type TestDb } from "./helpers";
import {
  newClient,
  newJob,
  newVehicle,
  PATH_TO,
  signedHandoverAct,
  step,
  walk,
} from "./jobs-fixtures";

let t: TestDb;
let formen: string;
let cashier: string;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  // Walks every transition, so it holds OWNER; permissions.db.test checks each role.
  formen = await createUser(t.migratorPool, { roles: ["FORMEN", "OWNER"] });
  cashier = await createUser(t.migratorPool, { roles: ["CASHIER"] });
  // The quality check names a mechanic (R3).
  await createUser(t.migratorPool, { roles: ["MECHANIC"] });
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

/** The cashier takes payment; the formen hands the car over (spec 00, section 4). */
const actorFor = (status: "ODENILDI" | "TEHVIL_VERILDI") =>
  status === "ODENILDI" ? cashier : formen;

describe("happy paths close automatically", () => {
  it.each([
    ["paid first", "ODENILDI", "TEHVIL_VERILDI"],
    ["handed over first (deferred payment)", "TEHVIL_VERILDI", "ODENILDI"],
  ] as const)("%s", async (_, first, second) => {
    const job = await jobAt("HAZIR");
    expect(await step(t.db, actorFor(first), job.id, first)).toBe(first);
    expect(await step(t.db, actorFor(second), job.id, second)).toBe("BAGLANDI");
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
    expect(history.at(-3)).toMatchObject({
      toStatus: first,
      userId: actorFor(first),
      reason: first === "TEHVIL_VERILDI" ? "audit.handedOver" : "test",
    });
    expect(history.at(-1)).toMatchObject({
      fromStatus: second,
      toStatus: "BAGLANDI",
      // The automatic close is recorded under whoever completed the second step.
      userId: actorFor(second),
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
  it.each([
    "QEBUL",
    "BAXIS",
    "QIYMETLENDIRME",
    "TESDIQ_GOZLEYIR",
    "TESDIQLENDI",
    "HISSE_GOZLEYIR",
    "TEMIRDE",
    "HAZIR",
  ] as const)("is possible from %s", async (from) => {
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

/** Inserts a job row directly (bypassing openJob) with a number taken from the counter. */
async function rawJob(vehicleId: string, extra: Record<string, string> = {}) {
  return withActor(t.db, { userId: formen }, async (tx) => {
    const { number } = await assignNumber(tx, "JOB_ORDER");
    const columns = {
      number,
      vehicle_id: vehicleId,
      contragent_id: client,
      contract_check: "NO_CONTRACT",
      formen_id: formen,
      ...extra,
    };
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO job_orders (${sql.raw(Object.keys(columns).join(", "))})
          VALUES (${sql.join(
            Object.values(columns).map((v) => sql`${v}`),
            sql`, `,
          )}) RETURNING id`,
    );
    return rows[0]!.id;
  });
}

describe("integrity", () => {
  it("the app cannot write job_status_events, and the owner cannot forge them", async () => {
    const job = await jobAt("TEHVIL_VERILDI");
    const forge = (pool: typeof t.appPool) =>
      sqlstateOf(
        asActor(pool, { userId: formen }, (c) =>
          c.query(
            "INSERT INTO job_status_events (job_order_id, from_status, to_status, user_id) VALUES ($1, 'HAZIR', 'ODENILDI', $2)",
            [job.id, formen],
          ),
        ),
      );
    expect(await forge(t.appPool)).toBe("42501");
    expect(await forge(t.migratorPool)).toBe("DM005");
    // So the unpaid job still cannot be closed.
    await expect(
      withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
        tx.update(jobOrders).set({ status: "BAGLANDI" }).where(eq(jobOrders.id, job.id)),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("number, vehicle, client, contract result and snapshots cannot change", async () => {
    const job = await jobAt("BAXIS");
    const other = await newVehicle(t.db, formen, "JBLFE");
    const otherClient = await newClient(t.db, formen);
    for (const set of [
      { number: "IS-2026-999999" },
      { vehicleId: other.id },
      { contragentId: otherClient },
      { contractCheck: "NOT_ON_CONTRACT", contractDecision: "SEPARATE_PAID" },
      { vinSnapshot: "FAKE" },
      { carReleased: true },
      { plateSnapshot: "FAKE" },
    ]) {
      await expect(
        withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
          tx.update(jobOrders).set(set).where(eq(jobOrders.id, job.id)),
        ),
        JSON.stringify(set),
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });

  it("snapshots come from the database and keep the plate the car arrived with", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE", "77-SN-001");
    const id = await rawJob(car.id, { vin_snapshot: "FAKEVIN", plate_snapshot: "FAKE" });
    await withActor(t.db, { userId: formen }, (tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "77-SN-002", source: "INTAKE" }),
    );
    const { rows } = await t.migratorPool.query(
      "SELECT vin_snapshot, plate_snapshot FROM job_orders WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ vin_snapshot: car.vin, plate_snapshot: "77-SN-001" });

    const noPlate = await newVehicle(t.db, formen, "JBLFE");
    const job = await newJob(t.db, formen, { vehicleId: noPlate.id, contragentId: client });
    const { rows: none } = await t.migratorPool.query(
      "SELECT vin_snapshot, plate_snapshot FROM job_orders WHERE id = $1",
      [job.id],
    );
    expect(none[0]).toEqual({ vin_snapshot: noPlate.vin, plate_snapshot: null });
  });

  it("a new job must start in QEBUL", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE");
    await expect(rawJob(car.id, { status: "TEMIRDE" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("the database refuses a status change without a reason (DM004)", async () => {
    const job = await jobAt("QEBUL");
    await expect(
      withActor(t.db, { userId: formen }, (tx) =>
        tx.update(jobOrders).set({ status: "BAXIS" }).where(eq(jobOrders.id, job.id)),
      ),
    ).rejects.toBeInstanceOf(ReasonRequiredError);
  });

  it("moving to the current status, or an unknown job, is an error, not a silent no-op", async () => {
    const job = await jobAt("BAXIS");
    await expect(
      withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "BAXIS", "x")),
    ).rejects.toThrow(/already BAXIS/);
    await expect(
      withActor(t.db, { userId: formen }, (tx) =>
        moveJob(tx, "00000000-0000-0000-0000-00000000dead", "BAXIS", "x"),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("payment and handover each happen once, whatever the app does", async () => {
    const job = await jobAt("HAZIR");
    await signedHandoverAct(t.db, formen, job.id);
    const set = (status: JobStatus) =>
      withActor(t.db, { userId: formen, reason: "direct" }, (tx) =>
        tx.update(jobOrders).set({ status }).where(eq(jobOrders.id, job.id)),
      );
    await set("ODENILDI");
    await set("TEHVIL_VERILDI");
    await expect(set("ODENILDI")).rejects.toBeInstanceOf(InvalidTransitionError);
    await set("BAGLANDI");
    expect(await statusOf(job.id)).toBe("BAGLANDI");
  });

  it("status changes are audited too, with user and reason", async () => {
    const job = await jobAt("QEBUL");
    await withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "BAXIS", "baxışa"));
    const { rows } = await t.migratorPool.query(
      `SELECT action, user_id, reason, before->>'status' AS before, after->>'status' AS after
         FROM audit_log WHERE table_name = 'job_orders' AND record_id = $1 ORDER BY id`,
      [job.id],
    );
    expect(rows).toEqual([
      {
        action: "INSERT",
        user_id: formen,
        reason: "audit.jobOpened",
        before: null,
        after: "QEBUL",
      },
      { action: "UPDATE", user_id: formen, reason: "baxışa", before: "QEBUL", after: "BAXIS" },
    ]);
  });
});

describe("parts loop and late cancellation", () => {
  it("HISSE_GOZLEYIR -> TEMIRDE -> HISSE_GOZLEYIR -> TEMIRDE works, one event each", async () => {
    const job = await jobAt("HISSE_GOZLEYIR");
    await walk(t.db, formen, job.id, ["TEMIRDE", "HISSE_GOZLEYIR", "TEMIRDE", "HAZIR"]);
    const history = await jobHistory(t.db, job.id);
    expect(history.slice(-4).map((e) => e.toStatus)).toEqual([
      "TEMIRDE",
      "HISSE_GOZLEYIR",
      "TEMIRDE",
      "HAZIR",
    ]);
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
    const error = await rawJob(car.id).catch((e: unknown) => e);
    expect(pgErrorOf(error)).toMatchObject({
      code: "23505",
      constraint: "job_orders_one_open_per_vehicle",
    });

    await withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, first.id, "səhv maşın"));
    const second = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    expect(second.number).not.toBe(first.number);
  });

  it("a car handed over on deferred payment can come back before the old job is paid", async () => {
    const old = await jobAt("TEHVIL_VERILDI");
    const next = await newJob(t.db, formen, { vehicleId: old.vehicle.id, contragentId: client });
    expect(next.number).not.toBe(old.number);
    expect(
      await withActor(t.db, { userId: formen }, (tx) => moveJob(tx, old.id, "ODENILDI", "ödəndi")),
    ).toBe("BAGLANDI");
  });

  it("a job number not handed out by the counter is refused", async () => {
    const car = await newVehicle(t.db, formen, "JBLFE");
    const { rows } = await t.db.execute<{ y: number }>(
      sql`SELECT extract(year FROM baku_date())::int AS y`,
    );
    for (const number of [`IS-${rows[0]!.y}-900000`, "IS-2000-000001"]) {
      expect(
        await sqlstateOf(
          asActor(t.appPool, { userId: formen }, (c) =>
            c.query(
              `INSERT INTO job_orders (number, vehicle_id, contragent_id, contract_check, formen_id)
               VALUES ($1, $2, $3, 'NO_CONTRACT', $4)`,
              [number, car.id, client, formen],
            ),
          ),
        ),
        number,
      ).toBe("DM005");
    }
  });

  it("a rolled-back open does not use up a number", async () => {
    const before = await newJob(t.db, formen, {
      vehicleId: (await newVehicle(t.db, formen, "JBLFE")).id,
      contragentId: client,
    });
    const car = await newVehicle(t.db, formen, "JBLFE");
    await expect(
      withActor(t.db, { userId: formen }, async (tx) => {
        await openJob(tx, { vehicleId: car.id, contragentId: client, formenId: formen });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const after = await newJob(t.db, formen, { vehicleId: car.id, contragentId: client });
    expect(Number(after.number.slice(-6))).toBe(Number(before.number.slice(-6)) + 1);
  });

  it("50 concurrent opens get consecutive IS numbers; no number is skipped", async () => {
    const cars = [];
    for (let i = 0; i < 50; i++) cars.push(await newVehicle(t.db, formen, "JBCNC"));
    await Promise.all(
      cars.map((car) => newJob(t.db, formen, { vehicleId: car.id, contragentId: client })),
    );
    const { rows } = await t.db.execute<{ number: string }>(
      sql`SELECT number FROM job_orders WHERE number LIKE 'IS-' || extract(year FROM baku_date())::int || '-%'`,
    );
    const sequences = rows.map((r) => Number(r.number.slice(-6))).sort((a, b) => a - b);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
    expect(sequences.length).toBeGreaterThanOrEqual(50);
  });
});

describe("held for management", () => {
  async function heldJob() {
    const company = await newClient(t.db, formen, "HUQUQI");
    await withActor(t.db, { userId: formen }, (tx) =>
      createContract(tx, {
        contragentId: company,
        number: `H-${Math.random()}`,
        signedOn: "2026-01-01",
        validFrom: "2026-01-01",
      }),
    );
    const car = await newVehicle(t.db, formen, "JBLFE");
    return newJob(t.db, formen, {
      vehicleId: car.id,
      contragentId: company,
      contractDecision: "HOLD_FOR_MANAGEMENT",
    });
  }

  it("cannot leave QEBUL until management releases it; it can be cancelled", async () => {
    const job = await heldJob();
    await expect(
      withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "BAXIS", "x")),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    await withActor(t.db, { userId: formen }, (tx) =>
      resolveHold(tx, job.id, "Rəhbərlik: ayrıca ödənişli iş"),
    );
    await withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "BAXIS", "baxış"));
    expect(await statusOf(job.id)).toBe("BAXIS");
    await expect(
      withActor(t.db, { userId: formen }, (tx) => resolveHold(tx, job.id, "again")),
    ).rejects.toThrow(/not held/);

    const another = await heldJob();
    await withActor(t.db, { userId: formen }, (tx) => cancelJob(tx, another.id, "gözləmədi"));
    expect(await statusOf(another.id)).toBe("LEGV");
  });

  it("the decision cannot be rewritten except by releasing a hold", async () => {
    const job = await heldJob();
    await withActor(t.db, { userId: formen }, (tx) => resolveHold(tx, job.id, "buraxıldı"));
    await expect(
      withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
        tx
          .update(jobOrders)
          .set({ contractDecision: "HOLD_FOR_MANAGEMENT" })
          .where(eq(jobOrders.id, job.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
    const { rows } = await t.migratorPool.query(
      `SELECT user_id, reason, after->>'contract_decision' AS decision FROM audit_log
        WHERE table_name = 'job_orders' AND record_id = $1 AND action = 'UPDATE'`,
      [job.id],
    );
    expect(rows).toEqual([{ user_id: formen, reason: "buraxıldı", decision: "SEPARATE_PAID" }]);
  });
});

describe("concurrent moves", () => {
  it("two simultaneous moves to the same status: one wins, the other is an error", async () => {
    const job = await jobAt("HAZIR");
    const results = await Promise.allSettled([
      withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "ODENILDI", "kassa 1")),
      withActor(t.db, { userId: formen }, (tx) => moveJob(tx, job.id, "ODENILDI", "kassa 2")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const paid = (await jobHistory(t.db, job.id)).filter((e) => e.toStatus === "ODENILDI");
    expect(paid).toHaveLength(1);
  });
});
