// Plan 01, P11-P13. Spec 00, section 3a and acceptance criteria 7, 8 and 9.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documents } from "@/db/schema";
import { withActor } from "@/lib/audit";
import { ImmutableError } from "@/lib/db/errors";
import {
  createVehicle,
  normalizePlate,
  PlateConflictError,
  recordPlate,
  searchByPlate,
} from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { submitted } from "./documents-fixtures";
import { createTestDb, type TestDb } from "./helpers";

let t: TestDb;
let formen: string;
let today: string;

beforeAll(async () => {
  t = await createTestDb();
  formen = await createUser(t.migratorPool, { roles: ["FORMEN"] });
  const { rows } = await t.db.execute<{ d: string }>(sql`SELECT baku_date()::text AS d`);
  today = rows[0]!.d;
});
afterAll(() => t.close());

let vinCounter = 0;
async function vehicle(plate?: string) {
  const vin = `WDB9634031L${String(++vinCounter).padStart(6, "0")}`;
  const { id } = await withActor(t.db, { userId: formen }, (tx) =>
    createVehicle(tx, { vin, plate: plate ? { display: plate, source: "INTAKE" } : undefined }),
  );
  return { id, vin };
}

const setPlate = (vehicleId: string, plateDisplay: string) =>
  withActor(t.db, { userId: formen }, (tx) =>
    recordPlate(tx, { vehicleId, plateDisplay, source: "INTAKE" }),
  );

async function platesOf(vehicleId: string) {
  const { rows } = await t.migratorPool.query(
    `SELECT plate_display, plate_normalized, status, valid_from::text, valid_to::text
       FROM vehicle_plates WHERE vehicle_id = $1 ORDER BY created_at, id`,
    [vehicleId],
  );
  return rows;
}

async function documentRow(id: string) {
  const { rows } = await t.migratorPool.query("SELECT * FROM documents WHERE id = $1", [id]);
  return rows[0];
}

describe("acceptance criterion 7: plate changes keep history; documents keep their plate", () => {
  it("documents keep the plate and VIN they were numbered with", async () => {
    const car = await vehicle("90-JG-526");
    const old = await submitted(t.db, formen, "QUSUR_AKTI", { vehicleId: car.id });
    expect(await documentRow(old.id)).toMatchObject({
      vin_snapshot: car.vin,
      plate_snapshot: "90-JG-526",
    });

    const result = await setPlate(car.id, "10-AB-123");
    expect(result).toEqual({ changed: true, conflicts: [] });

    expect((await documentRow(old.id)).plate_snapshot).toBe("90-JG-526");
    const fresh = await submitted(t.db, formen, "QUSUR_AKTI", { vehicleId: car.id });
    expect(await documentRow(fresh.id)).toMatchObject({
      vin_snapshot: car.vin,
      plate_snapshot: "10-AB-123",
    });

    expect(await platesOf(car.id)).toEqual([
      expect.objectContaining({ plate_display: "90-JG-526", status: "ENDED", valid_to: today }),
      expect.objectContaining({ plate_display: "10-AB-123", status: "ACTIVE", valid_to: null }),
    ]);
  });

  it("every plate change is audited", async () => {
    const car = await vehicle("77-ZZ-777");
    await setPlate(car.id, "77-ZZ-778");
    const { rows } = await t.migratorPool.query(
      `SELECT a.action, a.after->>'plate_display' AS plate, a.after->>'status' AS status, a.reason
         FROM audit_log a JOIN vehicle_plates vp ON vp.id = a.record_id
        WHERE a.table_name = 'vehicle_plates' AND vp.vehicle_id = $1 ORDER BY a.id`,
      [car.id],
    );
    expect(rows).toEqual([
      { action: "INSERT", plate: "77-ZZ-777", status: "ACTIVE", reason: "audit.plateRecorded" },
      { action: "UPDATE", plate: "77-ZZ-777", status: "ENDED", reason: "audit.plateReplaced" },
      { action: "INSERT", plate: "77-ZZ-778", status: "ACTIVE", reason: "audit.plateRecorded" },
    ]);
  });

  it("a numbered document's snapshots cannot be changed (DM005)", async () => {
    const car = await vehicle("55-XY-001");
    const doc = await submitted(t.db, formen, "QUSUR_AKTI", { vehicleId: car.id });
    await expect(
      withActor(t.db, { userId: formen, reason: "x" }, (tx) =>
        tx.update(documents).set({ plateSnapshot: "OTHER" }).where(eq(documents.id, doc.id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("the same plate again changes nothing; a car without a plate is allowed", async () => {
    const car = await vehicle("12-QQ-345");
    expect(await setPlate(car.id, "12 qq 345")).toEqual({ changed: false, conflicts: [] });
    expect(await platesOf(car.id)).toHaveLength(1);
    const noPlate = await vehicle();
    expect(await platesOf(noPlate.id)).toEqual([]);
  });
});

describe("acceptance criterion 8: searching a former plate", () => {
  it("finds the car by its former plate in any spacing and labels it FORMER", async () => {
    const car = await vehicle("90-KM-111");
    await setPlate(car.id, "90-KM-222");
    for (const query of ["90KM111", "90 km 111", "90-km-111"]) {
      const results = await searchByPlate(t.db, query);
      expect(results[0], query).toMatchObject({
        vehicleId: car.id,
        vin: car.vin,
        plateDisplay: "90-KM-111",
        label: "FORMER",
        usedUntil: today,
      });
    }
    const current = await searchByPlate(t.db, "90KM222");
    expect(current[0]).toMatchObject({ vehicleId: car.id, label: "CURRENT", usedUntil: null });
  });

  it("matches by prefix, current plates first, and always returns a VIN", async () => {
    const results = await searchByPlate(t.db, "90-KM");
    expect(results.map((r) => r.plateDisplay)).toEqual(["90-KM-222", "90-KM-111"]);
    for (const r of results) expect(r.vin).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
    expect(await searchByPlate(t.db, "9")).toEqual([]);
    expect(await searchByPlate(t.db, "%")).toEqual([]);
  });

  it("normalizes plates in code exactly as the database does", async () => {
    const samples = ["90-JG-526", " 90 jg\t526 ", "а123вс 77", "AB.12-3", "ü-ş-ə"];
    for (const s of samples) {
      const { rows } = await t.db.execute<{ n: string }>(
        sql`SELECT upper(regexp_replace(${s}::text, '[[:space:]-]', '', 'g')) AS n`,
      );
      expect(normalizePlate(s), s).toBe(rows[0]!.n);
    }
  });
});

describe("acceptance criterion 9: a plate active on another car", () => {
  it("moves to the new car, marks the other UNCONFIRMED and reports it", async () => {
    const car1 = await vehicle("44-OLD-01");
    await setPlate(car1.id, "44-PP-444");
    const car2 = await vehicle();

    const result = await setPlate(car2.id, "44 pp 444");
    expect(result).toEqual({ changed: true, conflicts: [{ vehicleId: car1.id, vin: car1.vin }] });

    expect(await platesOf(car1.id)).toEqual([
      expect.objectContaining({ plate_display: "44-OLD-01", status: "ENDED", valid_to: today }),
      expect.objectContaining({
        plate_display: "44-PP-444",
        status: "UNCONFIRMED",
        valid_to: null,
      }),
    ]);
    expect(await platesOf(car2.id)).toEqual([
      expect.objectContaining({ plate_display: "44 pp 444", status: "ACTIVE" }),
    ]);

    const search = await searchByPlate(t.db, "44PP444");
    expect(search.map((r) => [r.vehicleId, r.label])).toEqual([
      [car2.id, "CURRENT"],
      [car1.id, "UNCONFIRMED"],
    ]);
  });

  it("when the UNCONFIRMED car returns with a new plate, that row ends (plan 01, F11)", async () => {
    const car1 = await vehicle("33-AA-333");
    const car2 = await vehicle();
    await setPlate(car2.id, "33-AA-333");
    await setPlate(car1.id, "33-BB-333");
    expect(await platesOf(car1.id)).toEqual([
      expect.objectContaining({ plate_display: "33-AA-333", status: "ENDED", valid_to: today }),
      expect.objectContaining({ plate_display: "33-BB-333", status: "ACTIVE" }),
    ]);
  });

  it("the database allows at most one ACTIVE plate per car and per plate", async () => {
    const car = await vehicle("66-CC-666");
    const other = await vehicle("66-CC-667");
    const insertActive = (vehicleId: string, plate: string) =>
      withActor(t.db, { userId: formen }, (tx) =>
        tx.execute(sql`INSERT INTO vehicle_plates (vehicle_id, plate_display, valid_from, status, source)
                       VALUES (${vehicleId}, ${plate}, baku_date(), 'ACTIVE', 'IMPORT')`),
      );
    await expect(insertActive(car.id, "66-CC-999")).rejects.toThrow();
    await expect(insertActive(other.id + "", "66 cc 666")).rejects.toThrow();
  });

  it("two cars recording the same plate at once leave exactly one ACTIVE row", async () => {
    const a = await vehicle();
    const b = await vehicle();
    const record = async (vehicleId: string) => {
      try {
        return await setPlate(vehicleId, "88-RR-888");
      } catch (e) {
        if (!(e instanceof PlateConflictError)) throw e;
        return setPlate(vehicleId, "88-RR-888");
      }
    };
    await Promise.all([record(a.id), record(b.id)]);
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM vehicle_plates WHERE plate_normalized = '88RR888' AND status = 'ACTIVE'",
    );
    expect(rows[0].n).toBe(1);
  });
});
