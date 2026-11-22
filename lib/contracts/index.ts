import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { contractVehicles, contracts, vehicles } from "@/db/schema";
import { withReason } from "@/lib/audit";
import { pgErrorOf } from "@/lib/db/errors";
import type { Db, Tx } from "@/lib/db/types";
import type { ContractCheck } from "@/lib/jobs/types";
import { Money, Rate } from "@/lib/money";
import { createVehicle, isValidVin, normalizeVin } from "@/lib/vehicles";

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

export async function addVehicle(
  tx: Tx,
  contractId: string,
  vehicleId: string,
  contractPlate?: string,
): Promise<string> {
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

/** Takes a car off a contract, e.g. when the client sold it (section 3a). */
export async function removeVehicle(tx: Tx, contractId: string, vehicleId: string, reason: string) {
  if (reason.trim() === "") throw new Error("Removing a vehicle from a contract needs a reason");
  await withReason(tx, reason, () =>
    tx
      .update(contractVehicles)
      .set({ removedOn: sql`baku_date()`, removedBy: sql`current_actor()`, removeReason: reason })
      .where(
        and(
          eq(contractVehicles.contractId, contractId),
          eq(contractVehicles.vehicleId, vehicleId),
          isNull(contractVehicles.removedOn),
        ),
      ),
  );
}

/**
 * Imports a contract's vehicle list by VIN, all or nothing. A list with any row
 * missing a VIN, an invalid or repeated VIN, or a car active on another contract is
 * rejected with every such row listed. New cars get the list's plate as a CONTRACT
 * plate; known cars keep their plate history (plan 02, C4).
 */
export async function importVehicleList(
  tx: Tx,
  contractId: string,
  rows: ImportRow[],
): Promise<{ added: number; alreadyOnContract: number; createdVehicles: number }> {
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
    ? await tx
        .select({
          vin: vehicles.vin,
          vehicleId: vehicles.id,
          onContract: contractVehicles.contractId,
        })
        .from(vehicles)
        .leftJoin(
          contractVehicles,
          and(eq(contractVehicles.vehicleId, vehicles.id), isNull(contractVehicles.removedOn)),
        )
        .where(inArray(vehicles.vin, valid))
    : [];
  const byVin = new Map(known.map((k) => [k.vin, k]));
  vins.forEach((vin, i) => {
    const onContract = byVin.get(vin)?.onContract;
    if (onContract && onContract !== contractId) {
      problems.push({ row: i + 1, problem: "ON_ANOTHER_CONTRACT", vin });
    }
  });
  if (problems.length > 0) {
    throw new ContractImportError(problems.sort((a, b) => a.row - b.row));
  }

  let added = 0;
  let alreadyOnContract = 0;
  let createdVehicles = 0;
  for (const [i, row] of rows.entries()) {
    const vin = vins[i]!;
    const existing = byVin.get(vin);
    if (existing?.onContract === contractId) {
      alreadyOnContract++;
      continue;
    }
    let vehicleId = existing?.vehicleId;
    if (!vehicleId) {
      ({ id: vehicleId } = await createVehicle(tx, {
        vin,
        make: row.make,
        model: row.model,
        plate: row.plate?.trim() ? { display: row.plate, source: "CONTRACT" } : undefined,
      }));
      createdVehicles++;
    }
    await addVehicle(tx, contractId, vehicleId, row.plate);
    added++;
  }
  return { added, alreadyOnContract, createdVehicles };
}

export interface ContractCheckResult {
  check: ContractCheck;
  contractId: string | null;
}

/**
 * The intake check (spec 01, section 3.3), by vehicle id (VIN), never by plate:
 * - ON_CONTRACT: the car is on one of this client's contracts and it is valid today;
 * - CONTRACT_EXPIRED: it is, but the contract is terminated, ended or not started;
 * - NOT_ON_CONTRACT: the client has an active contract, but not for this car;
 * - NO_CONTRACT: the client has no active contract (an ordinary paid job).
 */
export async function checkContract(
  db: Db | Tx,
  input: { vehicleId: string; contragentId: string },
): Promise<ContractCheckResult> {
  const covering = await db.execute<{ contract_id: string; valid: boolean }>(sql`
    SELECT c.id AS contract_id,
           (c.status = 'ACTIVE' AND c.valid_from <= baku_date()
             AND (c.valid_to IS NULL OR c.valid_to >= baku_date() OR c.auto_renew)) AS valid
      FROM contract_vehicles cv
      JOIN contracts c ON c.id = cv.contract_id
     WHERE cv.vehicle_id = ${input.vehicleId} AND cv.removed_on IS NULL
       AND c.contragent_id = ${input.contragentId}`);
  const row = covering.rows[0];
  if (row) {
    return { check: row.valid ? "ON_CONTRACT" : "CONTRACT_EXPIRED", contractId: row.contract_id };
  }

  const active = await db.execute<{ id: string }>(sql`
    SELECT id FROM contracts
     WHERE contragent_id = ${input.contragentId} AND status = 'ACTIVE'
     ORDER BY valid_from DESC LIMIT 1`);
  const contract = active.rows[0];
  return contract
    ? { check: "NOT_ON_CONTRACT", contractId: contract.id }
    : { check: "NO_CONTRACT", contractId: null };
}
