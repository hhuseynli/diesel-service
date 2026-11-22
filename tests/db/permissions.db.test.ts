// Plan 03, P6: the permission matrix (spec 00, section 10) and who triggers each job
// transition (section 4), enforced in lib.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "@/lib/audit";
import { createContract } from "@/lib/contracts";
import { createDraft } from "@/lib/documents";
import { cancelJob, moveJob, type JobStatus } from "@/lib/jobs";
import { ACTIONS, can, PermissionError, type Action } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/users/roles";
import { createVehicle } from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { createTestDb, type TestDb } from "./helpers";
import { newClient, newJob, newVehicle, PATH_TO, walk } from "./jobs-fixtures";

let t: TestDb;
const users = {} as Record<Role, string>;
let owner: string;

beforeAll(async () => {
  t = await createTestDb();
  for (const role of ROLES) users[role] = await createUser(t.migratorPool, { roles: [role] });
  owner = users.OWNER;
});
afterAll(() => t.close());

const as = <T>(userId: string, fn: Parameters<typeof withActor<T>>[2]) =>
  withActor(t.db, { userId }, fn);

describe("the section 10 matrix", () => {
  it.each(Object.keys(ACTIONS) as Action[])("%s", async (action) => {
    for (const role of ROLES) {
      const expected = role === "OWNER" || (ACTIONS[action] as readonly Role[]).includes(role);
      expect(await as(users[role], (tx) => can(tx, action)), `${role} ${action}`).toBe(expected);
    }
  });

  it("the matrix rows of spec 00, section 10", () => {
    expect(ACTIONS.CREATE_JOB).toEqual(["FORMEN"]);
    expect(ACTIONS.CREATE_WAREHOUSE_DOCUMENT).toEqual(["WAREHOUSEMAN"]);
    expect(ACTIONS.CONFIRM_CASH_PAYMENT).toEqual(["CASHIER"]);
    expect(ACTIONS.CONFIRM_TRANSFER_PAYMENT).toEqual(["BOOKKEEPER"]);
    expect(ACTIONS.CHANGE_PRICE).toEqual(["MANAGEMENT", "WAREHOUSEMAN"]);
    expect(ACTIONS.VIEW_FINANCIALS).toEqual([]);
    expect(ACTIONS.MANAGE_USERS).toEqual([]);
    // The mechanic has no permissions until tablets arrive (R3).
    for (const permitted of Object.values(ACTIONS)) {
      expect(permitted as readonly Role[]).not.toContain("MECHANIC");
    }
  });
});

describe("lib functions check before writing", () => {
  it("only the warehouse creates warehouse documents; only the formen the handover act", async () => {
    await expect(
      as(users.FORMEN, (tx) => createDraft(tx, { type: "ALIS" })),
    ).rejects.toBeInstanceOf(PermissionError);
    await as(users.WAREHOUSEMAN, (tx) => createDraft(tx, { type: "ALIS" }));
    await expect(
      as(users.WAREHOUSEMAN, (tx) => createDraft(tx, { type: "TEHVIL_TESLIM" })),
    ).rejects.toBeInstanceOf(PermissionError);
    await as(users.FORMEN, (tx) => createDraft(tx, { type: "TEHVIL_TESLIM" }));
  });

  it("vehicles by the formen or management; contracts by management", async () => {
    await expect(
      as(users.CASHIER, (tx) => createVehicle(tx, { vin: "WDB9634031L777001" })),
    ).rejects.toBeInstanceOf(PermissionError);
    await as(users.FORMEN, (tx) => createVehicle(tx, { vin: "WDB9634031L777002" }));
    const company = await newClient(t.db, users.FORMEN, "HUQUQI");
    const terms = { contragentId: company, signedOn: "2026-01-01", validFrom: "2026-01-01" };
    await expect(
      as(users.FORMEN, (tx) => createContract(tx, { ...terms, number: "P-1" })),
    ).rejects.toBeInstanceOf(PermissionError);
    await as(users.MANAGEMENT, (tx) => createContract(tx, { ...terms, number: "P-2" }));
  });

  it("only the formen (or owner) opens a job", async () => {
    const car = await newVehicle(t.db, users.FORMEN, "PRMSN");
    const client = await newClient(t.db, users.FORMEN);
    await expect(
      newJob(t.db, users.WAREHOUSEMAN, {
        vehicleId: car.id,
        contragentId: client,
        formenId: users.FORMEN,
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    await newJob(t.db, users.FORMEN, { vehicleId: car.id, contragentId: client });
  });
});

describe("job transitions follow 'who triggers' (section 4)", () => {
  const EXPECTED: [keyof typeof PATH_TO, JobStatus, Role, Role][] = [
    ["QEBUL", "BAXIS", "FORMEN", "WAREHOUSEMAN"],
    ["BAXIS", "QIYMETLENDIRME", "WAREHOUSEMAN", "FORMEN"],
    ["QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "WAREHOUSEMAN", "FORMEN"],
    ["TESDIQ_GOZLEYIR", "TESDIQLENDI", "MANAGEMENT", "WAREHOUSEMAN"],
    ["TESDIQLENDI", "TEMIRDE", "FORMEN", "CASHIER"],
    ["TEMIRDE", "HAZIR", "FORMEN", "MECHANIC"],
    ["HAZIR", "TEHVIL_VERILDI", "FORMEN", "BOOKKEEPER"],
    ["HAZIR", "ODENILDI", "CASHIER", "FORMEN"],
  ];

  it.each(EXPECTED)("%s -> %s: %s may, %s may not", async (from, to, allowedRole, refusedRole) => {
    const car = await newVehicle(t.db, owner, "PRMSN");
    const job = await newJob(t.db, owner, {
      vehicleId: car.id,
      contragentId: await newClient(t.db, owner),
    });
    await walk(t.db, owner, job.id, PATH_TO[from]);
    const move = (role: Role) =>
      as(users[role], (tx) => moveJob(tx, job.id, to as Exclude<JobStatus, "LEGV">, "test"));
    await expect(move(refusedRole)).rejects.toBeInstanceOf(PermissionError);
    await move(allowedRole);
  });

  it("cancelling: the formen at intake, management after", async () => {
    const atIntake = await newJob(t.db, owner, {
      vehicleId: (await newVehicle(t.db, owner, "PRMSN")).id,
      contragentId: await newClient(t.db, owner),
    });
    await as(users.FORMEN, (tx) => cancelJob(tx, atIntake.id, "Müştəri getdi"));

    const later = await newJob(t.db, owner, {
      vehicleId: (await newVehicle(t.db, owner, "PRMSN")).id,
      contragentId: await newClient(t.db, owner),
    });
    await walk(t.db, owner, later.id, ["BAXIS"]);
    await expect(as(users.FORMEN, (tx) => cancelJob(tx, later.id, "x"))).rejects.toBeInstanceOf(
      PermissionError,
    );
    await as(users.MANAGEMENT, (tx) => cancelJob(tx, later.id, "Rəhbərlik ləğv etdi"));
  });
});
