// Plan 02, P7: contracts, contract vehicles, the intake contract check (spec 01, 3.3),
// opening jobs, and documents tied to a job's vehicle.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractVehicles, contracts, documents, jobOrders } from "@/db/schema";
import { withActor } from "@/lib/audit";
import {
  addVehicle,
  checkContract,
  ContractImportError,
  createContract,
  importVehicleList,
  removeVehicle,
  terminateContract,
  VehicleOnAnotherContractError,
  type ContractInput,
} from "@/lib/contracts";
import { ImmutableError } from "@/lib/db/errors";
import { createDraft } from "@/lib/documents";
import { assignNumber } from "@/lib/numbering";
import { ContractDecisionRequiredError, WrongRoleError } from "@/lib/jobs";
import { recordPlate } from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { createTestDb, type TestDb } from "./helpers";
import { bakuDays, newClient, newJob, newVehicle } from "./jobs-fixtures";

let t: TestDb;
let manager: string;
let days: { today: string; yesterday: string; tomorrow: string };

beforeAll(async () => {
  t = await createTestDb();
  manager = await createUser(t.migratorPool, { roles: ["MANAGEMENT", "FORMEN"] });
  days = await bakuDays(t.db);
});
afterAll(() => t.close());

let contractCounter = 0;
async function contract(contragentId: string, extra: Partial<ContractInput> = {}) {
  return withActor(t.db, { userId: manager }, (tx) =>
    createContract(tx, {
      contragentId,
      number: `M-${++contractCounter}`,
      signedOn: "2026-01-10",
      validFrom: "2026-01-10",
      ...extra,
    }),
  );
}

const add = (contractId: string, vehicleId: string, plate?: string) =>
  withActor(t.db, { userId: manager }, (tx) => addVehicle(tx, contractId, vehicleId, plate));

const check = (vehicleId: string, contragentId: string) =>
  checkContract(t.db, { vehicleId, contragentId });

describe("checkContract, by VIN only", () => {
  it("ON_CONTRACT, whatever plate the contract lists or the car now has", async () => {
    const company = await newClient(t.db, manager, "HUQUQI", "Logistika MMC");
    const c = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT", "90-AB-100");
    await add(c, car.id, "99-OLD-99");
    expect(await check(car.id, company)).toEqual({ check: "ON_CONTRACT", contractId: c });
    await withActor(t.db, { userId: manager }, (tx) =>
      recordPlate(tx, { vehicleId: car.id, plateDisplay: "90-AB-101", source: "INTAKE" }),
    );
    expect((await check(car.id, company)).check).toBe("ON_CONTRACT");
  });

  it("NOT_ON_CONTRACT for another car of a client with a contract, and after removal", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const listed = await newVehicle(t.db, manager, "CNTRCT");
    const unlisted = await newVehicle(t.db, manager, "CNTRCT");
    await add(c, listed.id);
    expect(await check(unlisted.id, company)).toEqual({ check: "NOT_ON_CONTRACT", contractId: c });

    await withActor(t.db, { userId: manager }, (tx) =>
      removeVehicle(tx, c, listed.id, "Maşın satılıb"),
    );
    expect((await check(listed.id, company)).check).toBe("NOT_ON_CONTRACT");
  });

  it("NO_CONTRACT for a client without contracts", async () => {
    const person = await newClient(t.db, manager);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    expect(await check(car.id, person)).toEqual({ check: "NO_CONTRACT", contractId: null });
  });

  it("CONTRACT_EXPIRED when ended, not started or terminated; auto-renew stays valid", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const cases: [Partial<ContractInput>, string][] = [
      [{ validFrom: "2025-01-01", validTo: days.yesterday }, "CONTRACT_EXPIRED"],
      [{ validFrom: days.tomorrow }, "CONTRACT_EXPIRED"],
      [{ validFrom: "2025-01-01", validTo: days.yesterday, autoRenew: true }, "ON_CONTRACT"],
      [{ validFrom: "2025-01-01", validTo: days.today }, "ON_CONTRACT"],
    ];
    for (const [terms, expected] of cases) {
      const c = await contract(company, { signedOn: "2025-01-01", ...terms });
      const car = await newVehicle(t.db, manager, "CNTRCT");
      await add(c, car.id);
      expect((await check(car.id, company)).check, JSON.stringify(terms)).toBe(expected);
    }

    const terminated = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(terminated, car.id);
    await withActor(t.db, { userId: manager }, (tx) =>
      terminateContract(tx, terminated, "Müqavilə ləğv edildi"),
    );
    expect((await check(car.id, company)).check).toBe("CONTRACT_EXPIRED");
  });
});

describe("contract vehicles", () => {
  it("a car is on only one active contract", async () => {
    const a = await contract(await newClient(t.db, manager, "HUQUQI"));
    const b = await contract(await newClient(t.db, manager, "HUQUQI"));
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(a, car.id);
    await expect(add(b, car.id)).rejects.toBeInstanceOf(VehicleOnAnotherContractError);
    await withActor(t.db, { userId: manager }, (tx) => removeVehicle(tx, a, car.id, "Satılıb"));
    await add(b, car.id);
  });

  it("a row is only removed, once, and never edited or restored", async () => {
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    const car = await newVehicle(t.db, manager, "CNTRCT");
    const rowId = await add(c, car.id, "10-AA-100");
    await expect(
      withActor(t.db, { userId: manager, reason: "x" }, (tx) =>
        tx
          .update(contractVehicles)
          .set({ contractPlate: "X" })
          .where(eq(contractVehicles.id, rowId)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
    await withActor(t.db, { userId: manager }, (tx) => removeVehicle(tx, c, car.id, "Satılıb"));
    const [row] = await t.db.select().from(contractVehicles).where(eq(contractVehicles.id, rowId));
    expect(row).toMatchObject({
      removedOn: days.today,
      removedBy: manager,
      removeReason: "Satılıb",
    });
    await expect(
      withActor(t.db, { userId: manager, reason: "x" }, (tx) =>
        tx
          .update(contractVehicles)
          .set({ removedOn: null, removedBy: null, removeReason: null })
          .where(eq(contractVehicles.id, rowId)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("a terminated contract is frozen and never moves to another client", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const other = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    await expect(
      withActor(t.db, { userId: manager, reason: "x" }, (tx) =>
        tx.update(contracts).set({ contragentId: other }).where(eq(contracts.id, c)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
    await withActor(t.db, { userId: manager }, (tx) => terminateContract(tx, c, "Bitdi"));
    await expect(
      withActor(t.db, { userId: manager, reason: "x" }, (tx) =>
        tx
          .update(contracts)
          .set({ status: "ACTIVE", statusReason: null })
          .where(eq(contracts.id, c)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });
});

describe("importing a contract's vehicle list", () => {
  it("rejects the whole list, naming every bad row", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const elsewhere = await newVehicle(t.db, manager, "CNTRCT");
    await add(await contract(await newClient(t.db, manager, "HUQUQI")), elsewhere.id);

    const error = await withActor(t.db, { userId: manager }, (tx) =>
      importVehicleList(tx, c, [
        { vin: "XTC65115RE0000001", plate: "10-BB-001" },
        { plate: "10-BB-002" },
        { vin: "XTC65115RE000000I" },
        { vin: "xtc65115re0000001" },
        { vin: elsewhere.vin },
      ]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractImportError);
    expect((error as ContractImportError).problems).toEqual([
      { row: 2, problem: "MISSING_VIN" },
      { row: 3, problem: "INVALID_VIN", vin: "XTC65115RE000000I" },
      { row: 4, problem: "DUPLICATE_VIN", vin: "XTC65115RE0000001" },
      { row: 5, problem: "ON_ANOTHER_CONTRACT", vin: elsewhere.vin },
    ]);
    const rows = await t.db
      .select()
      .from(contractVehicles)
      .where(eq(contractVehicles.contractId, c));
    expect(rows).toEqual([]);
  });

  it("creates new cars with CONTRACT plates and leaves known cars' plates alone", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const known = await newVehicle(t.db, manager, "CNTRCT", "50-NN-500");

    const result = await withActor(t.db, { userId: manager }, (tx) =>
      importVehicleList(tx, c, [
        { vin: "XTC65115RE0000777", plate: "77-CT-777", make: "KAMAZ" },
        { vin: known.vin, plate: "50-OLD-50" },
      ]),
    );
    expect(result).toEqual({
      added: 2,
      alreadyOnContract: 0,
      createdVehicles: 1,
      plateConflicts: [],
    });

    const { rows: plates } = await t.migratorPool.query(
      `SELECT v.vin, vp.plate_display, vp.source, vp.status FROM vehicle_plates vp
         JOIN vehicles v ON v.id = vp.vehicle_id WHERE v.vin IN ('XTC65115RE0000777', $1)
        ORDER BY v.vin`,
      [known.vin],
    );
    expect(plates).toEqual(
      expect.arrayContaining([
        {
          vin: "XTC65115RE0000777",
          plate_display: "77-CT-777",
          source: "CONTRACT",
          status: "ACTIVE",
        },
        { vin: known.vin, plate_display: "50-NN-500", source: "INTAKE", status: "ACTIVE" },
      ]),
    );
    expect(plates).toHaveLength(2);
    // The list's plate for a known car is kept for reference only (C4).
    const { rows: listed } = await t.migratorPool.query(
      "SELECT contract_plate FROM contract_vehicles WHERE vehicle_id = $1 AND contract_id = $2",
      [known.id, c],
    );
    expect(listed).toEqual([{ contract_plate: "50-OLD-50" }]);
    expect((await check(known.id, company)).check).toBe("ON_CONTRACT");

    const again = await withActor(t.db, { userId: manager }, (tx) =>
      importVehicleList(tx, c, [{ vin: known.vin }]),
    );
    expect(again).toEqual({
      added: 0,
      alreadyOnContract: 1,
      createdVehicles: 0,
      plateConflicts: [],
    });
  });
});

describe("opening a job", () => {
  it("a contract warning needs the formen's decision, which is stored", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await expect(
      newJob(t.db, manager, { vehicleId: car.id, contragentId: company }),
    ).rejects.toEqual(new ContractDecisionRequiredError("NOT_ON_CONTRACT"));

    const job = await newJob(t.db, manager, {
      vehicleId: car.id,
      contragentId: company,
      contractDecision: "HOLD_FOR_MANAGEMENT",
    });
    const { rows } = await t.migratorPool.query(
      "SELECT contract_id, contract_check, contract_decision FROM job_orders WHERE id = $1",
      [job.id],
    );
    expect(rows[0]).toEqual({
      contract_id: null,
      contract_check: "NOT_ON_CONTRACT",
      contract_decision: "HOLD_FOR_MANAGEMENT",
    });
  });

  it("a car on a valid contract is linked to it; no decision is kept", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(c, car.id);
    const job = await newJob(t.db, manager, {
      vehicleId: car.id,
      contragentId: company,
      contractDecision: "SEPARATE_PAID",
    });
    expect(job.contractCheck).toBe("ON_CONTRACT");
    const { rows } = await t.migratorPool.query(
      "SELECT contract_id, contract_decision FROM job_orders WHERE id = $1",
      [job.id],
    );
    expect(rows[0]).toEqual({ contract_id: c, contract_decision: null });
  });

  it("the mechanic must hold the MECHANIC role", async () => {
    const cashier = await createUser(t.migratorPool, { roles: ["CASHIER"] });
    const mechanic = await createUser(t.migratorPool, { roles: ["MECHANIC"] });
    const person = await newClient(t.db, manager);
    await expect(
      newJob(t.db, manager, {
        vehicleId: (await newVehicle(t.db, manager, "CNTRCT")).id,
        contragentId: person,
        mechanicId: cashier,
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    await newJob(t.db, manager, {
      vehicleId: (await newVehicle(t.db, manager, "CNTRCT")).id,
      contragentId: person,
      mechanicId: mechanic,
    });
  });
});

describe("documents on a job are about the job's vehicle", () => {
  it("take the job's vehicle, and refuse another", async () => {
    const person = await newClient(t.db, manager);
    const car = await newVehicle(t.db, manager, "CNTRCT", "30-DD-300");
    const other = await newVehicle(t.db, manager, "CNTRCT");
    const job = await newJob(t.db, manager, { vehicleId: car.id, contragentId: person });

    const docId = await withActor(t.db, { userId: manager }, (tx) =>
      createDraft(tx, { type: "QUSUR_AKTI", jobOrderId: job.id }),
    );
    const [doc] = await t.db.select().from(documents).where(eq(documents.id, docId));
    expect(doc!.vehicleId).toBe(car.id);

    await expect(
      withActor(t.db, { userId: manager }, (tx) =>
        createDraft(tx, { type: "QUSUR_AKTI", jobOrderId: job.id, vehicleId: other.id }),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });
});

describe("contracts end and renew (review of plan 02)", () => {
  it("a renewal contract takes over the cars of an ended one", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const old = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(old, car.id);
    await withActor(t.db, { userId: manager }, (tx) => terminateContract(tx, old, "Yenilənir"));
    expect((await check(car.id, company)).check).toBe("CONTRACT_EXPIRED");

    const renewal = await contract(company);
    await add(renewal, car.id);
    expect(await check(car.id, company)).toEqual({ check: "ON_CONTRACT", contractId: renewal });
    const { rows } = await t.migratorPool.query(
      "SELECT remove_reason, removed_by FROM contract_vehicles WHERE contract_id = $1",
      [old],
    );
    expect(rows).toEqual([{ remove_reason: "audit.contractEnded", removed_by: manager }]);
  });

  it("an ended contract takes no new cars", async () => {
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    await withActor(t.db, { userId: manager }, (tx) => terminateContract(tx, c, "Bitdi"));
    await expect(add(c, (await newVehicle(t.db, manager, "CNTRCT")).id)).rejects.toBeInstanceOf(
      ImmutableError,
    );
  });

  it("the database sets the removal date and remover, whatever the app sends", async () => {
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    const car = await newVehicle(t.db, manager, "CNTRCT");
    const rowId = await add(c, car.id);
    await withActor(t.db, { userId: manager, reason: "Satılıb" }, (tx) =>
      tx
        .update(contractVehicles)
        .set({
          removedOn: "2000-01-01",
          removedBy: "00000000-0000-0000-0000-000000000001",
          removeReason: "Satılıb",
        })
        .where(eq(contractVehicles.id, rowId)),
    );
    const [row] = await t.db.select().from(contractVehicles).where(eq(contractVehicles.id, rowId));
    expect(row).toMatchObject({ removedOn: days.today, removedBy: manager, addedOn: days.today });
  });

  it("removing a car that is not on the contract is an error", async () => {
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await expect(
      withActor(t.db, { userId: manager }, (tx) => removeVehicle(tx, c, car.id, "x")),
    ).rejects.toThrow(/not on this contract/);
    await add(c, car.id);
    await withActor(t.db, { userId: manager }, (tx) => removeVehicle(tx, c, car.id, "Satılıb"));
    await expect(
      withActor(t.db, { userId: manager }, (tx) => removeVehicle(tx, c, car.id, "yenə")),
    ).rejects.toThrow(/not on this contract/);
  });

  it("a client whose contracts have all ended gets NO_CONTRACT for an unlisted car", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    await contract(company, {
      signedOn: "2025-01-01",
      validFrom: "2025-01-01",
      validTo: days.yesterday,
    });
    const car = await newVehicle(t.db, manager, "CNTRCT");
    expect((await check(car.id, company)).check).toBe("NO_CONTRACT");
  });

  it("an annulled contract is ignored", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(c, car.id);
    await withActor(t.db, { userId: manager, reason: "Səhv daxil edilib" }, (tx) =>
      tx
        .update(contracts)
        .set({ status: "ANNULLED", statusReason: "Səhv daxil edilib" })
        .where(eq(contracts.id, c)),
    );
    expect((await check(car.id, company)).check).toBe("NO_CONTRACT");
  });

  it("the import reports plates it moved off other cars", async () => {
    const holder = await newVehicle(t.db, manager, "CNTRCT", "66-PL-666");
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    const result = await withActor(t.db, { userId: manager }, (tx) =>
      importVehicleList(tx, c, [{ vin: "XTC65115RE0000888", plate: "66 PL 666" }]),
    );
    expect(result.plateConflicts).toEqual([{ vehicleId: holder.id, vin: holder.vin }]);
  });

  it("contract changes are audited with user and reason", async () => {
    const c = await contract(await newClient(t.db, manager, "HUQUQI"));
    await withActor(t.db, { userId: manager }, (tx) =>
      terminateContract(tx, c, "Müştəri imtina etdi"),
    );
    const { rows } = await t.migratorPool.query(
      `SELECT action, user_id, reason, after->>'status' AS status FROM audit_log
        WHERE table_name = 'contracts' AND record_id = $1 ORDER BY id`,
      [c],
    );
    expect(rows).toEqual([
      { action: "INSERT", user_id: manager, reason: null, status: "ACTIVE" },
      { action: "UPDATE", user_id: manager, reason: "Müştəri imtina etdi", status: "TERMINATED" },
    ]);
  });
});

describe("job contract links and roles (review of plan 02)", () => {
  it("CONTRACT_EXPIRED needs a decision too, and SEPARATE_PAID is stored", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company, {
      signedOn: "2025-01-01",
      validFrom: "2025-01-01",
      validTo: days.yesterday,
    });
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(c, car.id);
    await expect(
      newJob(t.db, manager, { vehicleId: car.id, contragentId: company }),
    ).rejects.toEqual(new ContractDecisionRequiredError("CONTRACT_EXPIRED"));
    const job = await newJob(t.db, manager, {
      vehicleId: car.id,
      contragentId: company,
      contractDecision: "SEPARATE_PAID",
    });
    const { rows } = await t.migratorPool.query(
      "SELECT contract_id, contract_check, contract_decision FROM job_orders WHERE id = $1",
      [job.id],
    );
    expect(rows[0]).toEqual({
      contract_id: null,
      contract_check: "CONTRACT_EXPIRED",
      contract_decision: "SEPARATE_PAID",
    });
  });

  it("the database refuses a job linked to another client's contract", async () => {
    const company = await newClient(t.db, manager, "HUQUQI");
    const stranger = await newClient(t.db, manager, "HUQUQI");
    const c = await contract(company);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    await add(c, car.id);
    await expect(
      withActor(t.db, { userId: manager }, async (tx) => {
        const { number } = await assignNumber(tx, "JOB_ORDER");
        await tx.insert(jobOrders).values({
          number,
          vehicleId: car.id,
          contragentId: stranger,
          contractId: c,
          contractCheck: "ON_CONTRACT",
          formenId: manager,
        });
      }),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("the formen must hold the FORMEN (or OWNER) role", async () => {
    const cashier = await createUser(t.migratorPool, { roles: ["CASHIER"] });
    await expect(
      newJob(t.db, cashier, {
        vehicleId: (await newVehicle(t.db, manager, "CNTRCT")).id,
        contragentId: await newClient(t.db, manager),
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
  });

  it("a document on a job takes the job's client, and keeps it on update", async () => {
    const person = await newClient(t.db, manager);
    const other = await newClient(t.db, manager);
    const car = await newVehicle(t.db, manager, "CNTRCT");
    const otherCar = await newVehicle(t.db, manager, "CNTRCT");
    const job = await newJob(t.db, manager, { vehicleId: car.id, contragentId: person });
    const docId = await withActor(t.db, { userId: manager }, (tx) =>
      createDraft(tx, { type: "QUSUR_AKTI", jobOrderId: job.id }),
    );
    const [doc] = await t.db.select().from(documents).where(eq(documents.id, docId));
    expect(doc).toMatchObject({ vehicleId: car.id, contragentId: person });
    for (const set of [{ contragentId: other }, { vehicleId: otherCar.id }]) {
      await expect(
        withActor(t.db, { userId: manager, reason: "x" }, (tx) =>
          tx.update(documents).set(set).where(eq(documents.id, docId)),
        ),
      ).rejects.toBeInstanceOf(ImmutableError);
    }
  });
});
