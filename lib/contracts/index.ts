import { and, eq, isNull, sql } from "drizzle-orm";
import { contractVehicles, contracts } from "@/db/schema";
import { withReason } from "@/lib/audit";
import { pgErrorOf } from "@/lib/db/errors";
import type { Db, Tx } from "@/lib/db/types";
import type { ContractCheck } from "@/lib/jobs/types";
import { Money, Rate } from "@/lib/money";
import { createVehicle, isValidVin, normalizeVin, type PlateConflict } from "@/lib/vehicles";

// Contracts with corporate clients and the vehicles they cover (spec 00, sections 3
// and 3a; plan 02). Vehicles are matched by VIN only; the plate in a contract is
// kept for reference and never used to identify a car (R25, spec 01 AC1a).

export interface ContractInput {
  contragentId: string;
  number: string;
  signedOn: string;
  validFrom: string;
  validTo?: string;
  autoRenew?: boolean;
  deferredPaymentDays?: number;
  advanceThresholdExVat?: string;
  advancePercent?: string;
  /** Percent per day, up to 4 decimals, e.g. "0.1" (R17). */
  penaltyRateDaily?: string;
  penaltyCapPercent?: string;
}

/** The vehicle is already active on another contract (plan 02, C2). */
export class VehicleOnAnotherContractError extends Error {}

export interface ImportRow {
  vin?: string;
  plate?: string;
  make?: string;
  model?: string;
}

export interface ImportProblem {
  /** 1-based row number in the list as given. */
  row: number;
  problem: "MISSING_VIN" | "INVALID_VIN" | "DUPLICATE_VIN" | "ON_ANOTHER_CONTRACT";
  vin?: string;
}

/** A vehicle list was rejected as a whole; every problem row is listed (section 3a). */
export class ContractImportError extends Error {
  constructor(readonly problems: ImportProblem[]) {
    super(`Vehicle list rejected: ${problems.length} problem row(s)`);
  }
}

export async function createContract(tx: Tx, input: ContractInput): Promise<string> {
  if (
    input.penaltyRateDaily !== undefined &&
    !/^\d{1,3}(\.\d{1,4})?$/.test(input.penaltyRateDaily)
  ) {
    throw new RangeError(`Invalid daily penalty rate "${input.penaltyRateDaily}"`);
  }
  const [row] = await tx
    .insert(contracts)
    .values({
      contragentId: input.contragentId,
      number: input.number.trim(),
      signedOn: input.signedOn,
      validFrom: input.validFrom,
      validTo: input.validTo,
      autoRenew: input.autoRenew ?? false,
      deferredPaymentDays: input.deferredPaymentDays ?? 0,
      advanceThresholdExVat: input.advanceThresholdExVat
        ? Money.parse(input.advanceThresholdExVat).toDb()
        : undefined,
      advancePercent: input.advancePercent ? Rate.parse(input.advancePercent).toDb() : undefined,
      penaltyRateDaily: input.penaltyRateDaily,
      penaltyCapPercent: input.penaltyCapPercent
        ? Rate.parse(input.penaltyCapPercent).toDb()
        : undefined,
    })
    .returning({ id: contracts.id });
  return row!.id;
}

/** Ends a contract. Its vehicles then check as CONTRACT_EXPIRED; the row is frozen. */
export async function terminateContract(tx: Tx, contractId: string, reason: string) {
  if (reason.trim() === "") throw new Error("Terminating a contract needs a reason");
  await withReason(tx, reason, () =>
    tx
      .update(contracts)
      .set({ status: "TERMINATED", statusReason: reason })
      .where(eq(contracts.id, contractId)),
  );
}

/** A contract that covers cars today: ACTIVE, started, and not ended unless it auto-renews (C1). */
const VALID_TODAY = sql.raw(`(c.status = 'ACTIVE' AND c.valid_from <= baku_date()
  AND (c.valid_to IS NULL OR c.valid_to >= baku_date() OR c.auto_renew))`);

/** The car's current contract row, if any, and whether that contract is valid today. */
async function currentContractOf(tx: Tx, vehicleId: string) {
  const { rows } = await tx.execute<{ contract_id: string; valid: boolean }>(sql`
    SELECT cv.contract_id, ${VALID_TODAY} AS valid
      FROM contract_vehicles cv JOIN contracts c ON c.id = cv.contract_id
     WHERE cv.vehicle_id = ${vehicleId} AND cv.removed_on IS NULL
       FOR UPDATE OF cv`);
  return rows[0];
}

/**
 * Puts a car on a contract. A car still listed on a contract that has ended (terminated,
 * annulled or expired) is taken off it first, so a renewal contract can take over its
 * cars. A car on another contract that is valid today is refused (plan 02, C2).
 */
export async function addVehicle(
  tx: Tx,
  contractId: string,
  vehicleId: string,
  contractPlate?: string,
): Promise<string> {
  const current = await currentContractOf(tx, vehicleId);
  if (current?.contract_id === contractId) {
    throw new VehicleOnAnotherContractError("The vehicle is already on this contract");
  }
  if (current && current.valid) {
    throw new VehicleOnAnotherContractError(
      "The vehicle is on another contract that is valid today",
    );
  }
  if (current) await removeVehicle(tx, current.contract_id, vehicleId, "audit.contractEnded");
  try {
    const [row] = await tx
      .insert(contractVehicles)
      .values({ contractId, vehicleId, contractPlate: contractPlate?.trim() || undefined })
      .returning({ id: contractVehicles.id });
    return row!.id;
  } catch (e) {
    if (pgErrorOf(e)?.constraint === "contract_vehicles_one_active_per_vehicle") {
      throw new VehicleOnAnotherContractError("The vehicle is already on an active contract", {
        cause: e,
      });
    }
    throw e;
  }
}

/**
 * Takes a car off a contract, e.g. when the client sold it (section 3a). The database
 * records the date and who removed it.
 */
export async function removeVehicle(tx: Tx, contractId: string, vehicleId: string, reason: string) {
  if (reason.trim() === "") throw new Error("Removing a vehicle from a contract needs a reason");
  const removed = await withReason(tx, reason, () =>
    tx
      .update(contractVehicles)
      .set({ removedOn: sql`baku_date()`, removedBy: sql`current_actor()`, removeReason: reason })
      .where(
        and(
          eq(contractVehicles.contractId, contractId),
          eq(contractVehicles.vehicleId, vehicleId),
          isNull(contractVehicles.removedOn),
        ),
      )
      .returning({ id: contractVehicles.id }),
  );
  if (removed.length === 0) throw new Error("The vehicle is not on this contract");
}

/**
 * Imports a contract's vehicle list by VIN, all or nothing. A list with any row
 * missing a VIN, an invalid or repeated VIN, or a car on another contract that is
 * valid today is rejected with every such row listed. New cars get the list's plate as
 * a CONTRACT plate; known cars keep their plate history (plan 02, C4). A list plate
 * that is currently on another car marks that car UNCONFIRMED; those are returned as
 * plate conflicts for the notice (section 3a, rule 5).
 */
export async function importVehicleList(
  tx: Tx,
  contractId: string,
  rows: ImportRow[],
): Promise<{
  added: number;
  alreadyOnContract: number;
  createdVehicles: number;
  plateConflicts: PlateConflict[];
}> {
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();
  const vins: string[] = [];
  rows.forEach((r, i) => {
    const vin = r.vin ? normalizeVin(r.vin) : "";
    if (vin === "") problems.push({ row: i + 1, problem: "MISSING_VIN" });
    else if (!isValidVin(vin)) problems.push({ row: i + 1, problem: "INVALID_VIN", vin });
    else if (seen.has(vin)) problems.push({ row: i + 1, problem: "DUPLICATE_VIN", vin });
    else seen.add(vin);
    vins.push(vin);
  });

  const valid = [...seen];
  const known = valid.length
    ? (
        await tx.execute<{
          vin: string;
          vehicle_id: string;
          contract_id: string | null;
          valid: boolean | null;
        }>(sql`
          SELECT v.vin, v.id AS vehicle_id, cv.contract_id, ${VALID_TODAY} AS valid
            FROM vehicles v
            LEFT JOIN contract_vehicles cv ON cv.vehicle_id = v.id AND cv.removed_on IS NULL
            LEFT JOIN contracts c ON c.id = cv.contract_id
           WHERE v.vin IN (${sql.join(
             valid.map((v) => sql`${v}`),
             sql`, `,
           )})`)
      ).rows
    : [];
  const byVin = new Map(known.map((k) => [k.vin, k]));
  vins.forEach((vin, i) => {
    const k = byVin.get(vin);
    if (k?.contract_id && k.contract_id !== contractId && k.valid) {
      problems.push({ row: i + 1, problem: "ON_ANOTHER_CONTRACT", vin });
    }
  });
  if (problems.length > 0) {
    throw new ContractImportError(problems.sort((a, b) => a.row - b.row));
  }

  let added = 0;
  let alreadyOnContract = 0;
  let createdVehicles = 0;
  const plateConflicts: PlateConflict[] = [];
  for (const [i, row] of rows.entries()) {
    const vin = vins[i]!;
    const existing = byVin.get(vin);
    if (existing?.contract_id === contractId) {
      alreadyOnContract++;
      continue;
    }
    let vehicleId = existing?.vehicle_id;
    if (!vehicleId) {
      const created = await createVehicle(tx, {
        vin,
        make: row.make,
        model: row.model,
        plate: row.plate?.trim() ? { display: row.plate, source: "CONTRACT" } : undefined,
      });
      vehicleId = created.id;
      plateConflicts.push(...created.conflicts);
      createdVehicles++;
    }
    await addVehicle(tx, contractId, vehicleId, row.plate);
    added++;
  }
  return { added, alreadyOnContract, createdVehicles, plateConflicts };
}

export interface ContractCheckResult {
  check: ContractCheck;
  contractId: string | null;
}

/**
 * The intake check (spec 01, section 3.3), by vehicle id (VIN), never by plate.
 * Annulled contracts (entered by mistake) are ignored.
 * - ON_CONTRACT: the car is on one of this client's contracts and it is valid today;
 * - CONTRACT_EXPIRED: it is, but that contract is terminated, ended or not started;
 * - NOT_ON_CONTRACT: the client has a contract valid today, but not for this car;
 * - NO_CONTRACT: none of the above: an ordinary paid job, without a warning.
 */
export async function checkContract(
  db: Db | Tx,
  input: { vehicleId: string; contragentId: string },
): Promise<ContractCheckResult> {
  const covering = await db.execute<{ contract_id: string; valid: boolean }>(sql`
    SELECT c.id AS contract_id, ${VALID_TODAY} AS valid
      FROM contract_vehicles cv
      JOIN contracts c ON c.id = cv.contract_id
     WHERE cv.vehicle_id = ${input.vehicleId} AND cv.removed_on IS NULL
       AND c.contragent_id = ${input.contragentId} AND c.status <> 'ANNULLED'`);
  const row = covering.rows[0];
  if (row) {
    return { check: row.valid ? "ON_CONTRACT" : "CONTRACT_EXPIRED", contractId: row.contract_id };
  }

  const current = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM contracts c
     WHERE c.contragent_id = ${input.contragentId} AND ${VALID_TODAY}
     ORDER BY c.valid_from DESC LIMIT 1`);
  const contract = current.rows[0];
  return contract
    ? { check: "NOT_ON_CONTRACT", contractId: contract.id }
    : { check: "NO_CONTRACT", contractId: null };
}
