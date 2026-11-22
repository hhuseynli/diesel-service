import { sql } from "drizzle-orm";
import { vehicles } from "@/db/schema";
import { withReason } from "@/lib/audit";
import { pgErrorOf } from "@/lib/db/errors";
import type { Db, Tx } from "@/lib/db/types";
import { normalizePlate } from "./plates";
import { isValidVin, normalizeVin } from "./vin";

export { normalizePlate } from "./plates";
export { isValidVin, normalizeVin } from "./vin";

// Vehicle identity and plate history (spec 00, section 3a; R25).

export type PlateSource = "INTAKE" | "CONTRACT" | "IMPORT";

/** Another vehicle whose ACTIVE plate was just set to UNCONFIRMED: the formen's notice. */
export interface PlateConflict {
  vehicleId: string;
  vin: string;
}

export interface RecordPlateResult {
  changed: boolean;
  conflicts: PlateConflict[];
}

/** Two transactions tried to make the same plate ACTIVE; retry in a new transaction. */
export class PlateConflictError extends Error {}

export async function createVehicle(
  tx: Tx,
  input: {
    vin: string;
    make?: string;
    model?: string;
    year?: number;
    engine?: string;
    decodeSource?: string;
    plate?: { display: string; source: PlateSource; jobOrderId?: string };
  },
): Promise<{ id: string; conflicts: PlateConflict[] }> {
  const vin = normalizeVin(input.vin);
  if (!isValidVin(vin)) throw new RangeError(`Invalid VIN "${input.vin}"`);
  const [vehicle] = await tx
    .insert(vehicles)
    .values({
      vin,
      make: input.make,
      model: input.model,
      year: input.year,
      engine: input.engine,
      decodeSource: input.decodeSource,
    })
    .returning({ id: vehicles.id });
  let conflicts: PlateConflict[] = [];
  if (input.plate) {
    ({ conflicts } = await recordPlate(tx, {
      vehicleId: vehicle!.id,
      plateDisplay: input.plate.display,
      source: input.plate.source,
      jobOrderId: input.plate.jobOrderId,
    }));
  }
  return { id: vehicle!.id, conflicts };
}

/**
 * Records the plate now on a vehicle, in one transaction (section 3a, rules 4 and 5):
 * - the same plate already ACTIVE on this vehicle: nothing changes;
 * - the plate ACTIVE on other vehicles: those rows become UNCONFIRMED (returned as conflicts);
 * - this vehicle's ACTIVE or UNCONFIRMED plate ends today (plan 01, F11);
 * - the new plate is inserted as ACTIVE.
 * Nothing is deleted or overwritten.
 */
export async function recordPlate(
  tx: Tx,
  input: { vehicleId: string; plateDisplay: string; source: PlateSource; jobOrderId?: string },
): Promise<RecordPlateResult> {
  const display = input.plateDisplay.trim();
  if (normalizePlate(display) === "") throw new RangeError("A plate needs at least one character");

  // Serializes plate changes for this vehicle.
  const locked = await tx.execute(
    sql`SELECT id FROM vehicles WHERE id = ${input.vehicleId} FOR UPDATE`,
  );
  if (locked.rows.length === 0) throw new Error(`Vehicle ${input.vehicleId} not found`);

  // Normalized in SQL with the generated column's own expression.
  const normalized = sql`upper(regexp_replace(${display}::text, '[[:space:]-]', '', 'g'))`;

  const current = await tx.execute(sql`
    SELECT 1 FROM vehicle_plates
     WHERE vehicle_id = ${input.vehicleId} AND status = 'ACTIVE'
       AND plate_normalized = ${normalized}`);
  if (current.rows.length > 0) return { changed: false, conflicts: [] };

  const moved = await withReason(tx, "audit.plateMovedToOtherVehicle", () =>
    tx.execute<{ vehicle_id: string; vin: string }>(sql`
      UPDATE vehicle_plates vp SET status = 'UNCONFIRMED'
        FROM vehicles v
       WHERE v.id = vp.vehicle_id AND vp.status = 'ACTIVE'
         AND vp.plate_normalized = ${normalized} AND vp.vehicle_id <> ${input.vehicleId}
      RETURNING vp.vehicle_id, v.vin`),
  );

  await withReason(tx, "audit.plateReplaced", () =>
    tx.execute(sql`
      UPDATE vehicle_plates SET status = 'ENDED', valid_to = baku_date()
       WHERE vehicle_id = ${input.vehicleId} AND status IN ('ACTIVE', 'UNCONFIRMED')`),
  );

  try {
    await withReason(tx, "audit.plateRecorded", () =>
      tx.execute(sql`
        INSERT INTO vehicle_plates (vehicle_id, plate_display, valid_from, status, source, job_order_id)
        VALUES (${input.vehicleId}, ${display}, baku_date(), 'ACTIVE', ${input.source},
                ${input.jobOrderId ?? null})`),
    );
  } catch (e) {
    if (pgErrorOf(e)?.constraint === "vehicle_plates_one_active_per_plate") {
      throw new PlateConflictError(`Plate ${display} was just recorded on another vehicle`, {
        cause: e,
      });
    }
    throw e;
  }

  return {
    changed: true,
    conflicts: moved.rows.map((r) => ({ vehicleId: r.vehicle_id, vin: r.vin })),
  };
}

export type PlateLabel = "CURRENT" | "FORMER" | "UNCONFIRMED";

export interface PlateSearchResult {
  vehicleId: string;
  vin: string;
  make: string | null;
  model: string | null;
  plateDisplay: string;
  label: PlateLabel;
  validFrom: string;
  /** Set for FORMER plates: "former plate, used until <date>". */
  usedUntil: string | null;
}

const LABELS: Record<string, PlateLabel> = {
  ACTIVE: "CURRENT",
  ENDED: "FORMER",
  UNCONFIRMED: "UNCONFIRMED",
};

/**
 * Finds vehicles by current and former plates (section 3a, Search). Every result leads
 * to a VIN. Exact matches first, then current plates, then the most recently ended.
 */
export async function searchByPlate(db: Db | Tx, query: string): Promise<PlateSearchResult[]> {
  if (normalizePlate(query).length < 2) return [];
  const result = await db.execute<{
    vehicle_id: string;
    vin: string;
    make: string | null;
    model: string | null;
    plate_display: string;
    status: string;
    valid_from: string;
    valid_to: string | null;
  }>(sql`
    WITH q AS (SELECT upper(regexp_replace(${query}::text, '[[:space:]-]', '', 'g')) AS n)
    SELECT v.id AS vehicle_id, v.vin, v.make, v.model, vp.plate_display, vp.status,
           vp.valid_from::text AS valid_from, vp.valid_to::text AS valid_to
      FROM vehicle_plates vp
      JOIN vehicles v ON v.id = vp.vehicle_id, q
     WHERE vp.plate_normalized LIKE replace(replace(replace(q.n, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
     ORDER BY (vp.plate_normalized = q.n) DESC, (vp.status = 'ACTIVE') DESC,
              vp.valid_to DESC NULLS FIRST, vp.created_at DESC
     LIMIT 50`);
  return result.rows.map((r) => ({
    vehicleId: r.vehicle_id,
    vin: r.vin,
    make: r.make,
    model: r.model,
    plateDisplay: r.plate_display,
    label: LABELS[r.status]!,
    validFrom: r.valid_from,
    usedUntil: r.status === "ENDED" ? r.valid_to : null,
  }));
}
