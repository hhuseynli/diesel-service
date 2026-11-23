// Plan 03, P6: the permission matrix (spec 00, section 10) and who triggers each job
// transition (section 4), enforced in lib.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "@/lib/audit";
import { registerTablet, unlockUser } from "@/lib/auth";
import {
  addVehicle,
  createContract,
  importVehicleList,
  removeVehicle,
  terminateContract,
} from "@/lib/contracts";
import { annulDocument, createDraft, submitDocument } from "@/lib/documents";
import { cancelJob, moveJob, resolveHold, type JobStatus } from "@/lib/jobs";
import { ACTIONS, can, PermissionError, type Action } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/users/roles";
import { createVehicle, recordPlate } from "@/lib/vehicles";
import { createUser } from "./fixtures";
import { createTestDb, type TestDb } from "./helpers";
import { qualityCheck, qualityChecklist } from "@/lib/intake";
import {
  fakeAttachment,
  newClient,
  newJob,
  newVehicle,
  PATH_TO,
  step,
  walk,
} from "./jobs-fixtures";

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
    // HAZIR and TEHVIL_VERILDI are reached only through the quality check and handover.
    const move = (role: Role) =>
      to === "HAZIR"
        ? as(users[role], async (tx) =>
            qualityCheck(tx, job.id, {
              items: Object.fromEntries((await qualityChecklist(tx)).map((i) => [i, true])),
              dashboardPhotoId: await fakeAttachment(tx),
              mechanicId: users.MECHANIC,
            }),
          )
        : step(t.db, users[role], job.id, to);
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

describe("every row, against plan 03 (F29 for rows beyond section 10)", () => {
  it("matches the agreed matrix exactly", () => {
    expect(ACTIONS).toEqual({
      CREATE_JOB: ["FORMEN"],
      RECORD_INSPECTION: ["FORMEN"],
      PRINT_STICKER: ["FORMEN"],
      CANCEL_JOB_AT_INTAKE: ["FORMEN", "MANAGEMENT"],
      CANCEL_JOB: ["MANAGEMENT"],
      RESOLVE_HOLD: ["MANAGEMENT"],
      RECORD_VEHICLE: ["FORMEN", "MANAGEMENT"],
      MANAGE_CONTRACTS: ["MANAGEMENT"],
      CREATE_WAREHOUSE_DOCUMENT: ["WAREHOUSEMAN"],
      CREATE_HANDOVER_DOCUMENT: ["FORMEN"],
      CHANGE_PRICE: ["MANAGEMENT", "WAREHOUSEMAN"],
      CONFIRM_CASH_PAYMENT: ["CASHIER"],
      CONFIRM_TRANSFER_PAYMENT: ["BOOKKEEPER"],
      VIEW_FINANCIALS: [],
      MANAGE_USERS: [],
      UNLOCK_USER: ["MANAGEMENT"],
      REGISTER_TABLET: ["MANAGEMENT"],
    });
  });

  it("more lib functions refuse the wrong role", async () => {
    const company = await newClient(t.db, users.FORMEN, "HUQUQI");
    const contract = await as(users.MANAGEMENT, (tx) =>
      createContract(tx, {
        contragentId: company,
        number: "P-9",
        signedOn: "2026-01-01",
        validFrom: "2026-01-01",
      }),
    );
    const car = await newVehicle(t.db, users.FORMEN, "PRMSN", "11-PR-111");
    const refused: [string, () => Promise<unknown>][] = [
      ["addVehicle", () => as(users.FORMEN, (tx) => addVehicle(tx, contract, car.id))],
      ["terminateContract", () => as(users.FORMEN, (tx) => terminateContract(tx, contract, "x"))],
      ["importVehicleList", () => as(users.FORMEN, (tx) => importVehicleList(tx, contract, []))],
      [
        "recordPlate",
        () =>
          as(users.CASHIER, (tx) =>
            recordPlate(tx, { vehicleId: car.id, plateDisplay: "11-PR-112", source: "INTAKE" }),
          ),
      ],
      ["registerTablet", () => as(users.FORMEN, (tx) => registerTablet(tx, "x"))],
      ["unlockUser", () => as(users.FORMEN, (tx) => unlockUser(tx, users.CASHIER, "x"))],
    ];
    for (const [name, attempt] of refused) {
      await expect(attempt(), name).rejects.toBeInstanceOf(PermissionError);
    }
    await as(users.MANAGEMENT, (tx) => addVehicle(tx, contract, car.id));
    await expect(
      as(users.FORMEN, (tx) => removeVehicle(tx, contract, car.id, "x")),
    ).rejects.toBeInstanceOf(PermissionError);

    const doc = await as(users.WAREHOUSEMAN, (tx) => createDraft(tx, { type: "MEDAXIL" }));
    await expect(as(users.FORMEN, (tx) => submitDocument(tx, doc))).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(as(users.FORMEN, (tx) => annulDocument(tx, doc, "x"))).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it("holds are released by management only; nobody moves a job back into QEBUL", async () => {
    const company = await newClient(t.db, owner, "HUQUQI");
    await as(users.MANAGEMENT, (tx) =>
      createContract(tx, {
        contragentId: company,
        number: "P-10",
        signedOn: "2026-01-01",
        validFrom: "2026-01-01",
      }),
    );
    const held = await newJob(t.db, owner, {
      vehicleId: (await newVehicle(t.db, owner, "PRMSN")).id,
      contragentId: company,
      contractDecision: "HOLD_FOR_MANAGEMENT",
    });
    await expect(as(users.FORMEN, (tx) => resolveHold(tx, held.id, "x"))).rejects.toBeInstanceOf(
      PermissionError,
    );
    await as(users.MANAGEMENT, (tx) => resolveHold(tx, held.id, "Rəhbərlik buraxdı"));
    await walk(t.db, owner, held.id, ["BAXIS"]);
    await expect(
      as(owner, (tx) => moveJob(tx, held.id, "QEBUL" as Exclude<JobStatus, "LEGV">, "x")),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("the bookkeeper takes transfers (ODENILDI); the warehouse marks parts missing", async () => {
    const job = await newJob(t.db, owner, {
      vehicleId: (await newVehicle(t.db, owner, "PRMSN")).id,
      contragentId: await newClient(t.db, owner),
    });
    await walk(t.db, owner, job.id, PATH_TO.TESDIQLENDI);
    await as(users.WAREHOUSEMAN, (tx) => moveJob(tx, job.id, "HISSE_GOZLEYIR", "Hissə yoxdur"));
    await walk(t.db, owner, job.id, ["TEMIRDE", "HAZIR"]);
    await as(users.BOOKKEEPER, (tx) => moveJob(tx, job.id, "ODENILDI", "Köçürmə gəldi"));
  });
});
