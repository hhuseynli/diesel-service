// Plan 01, P6: the database guarantees, read from pg_catalog rather than a hand-kept list,
// so a future table that misses its grants or triggers fails here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers";

let t: TestDb;
let tables: string[];
const APPEND_ONLY = ["audit_log", "job_status_events", "login_attempts"];
// Sign-in bookkeeping: stamped but not audited, last_seen_at changes on every request (plan 03, A9).
const OPERATIONAL = ["sessions"];

beforeAll(async () => {
  t = await createTestDb();
  const { rows } = await t.migratorPool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  tables = rows.map((r) => r.tablename);
});
afterAll(() => t.close());

async function appHas(table: string, privilege: string): Promise<boolean> {
  const { rows } = await t.migratorPool.query<{ ok: boolean }>(
    "SELECT has_table_privilege('diesel_app', $1, $2) AS ok",
    [`public.${table}`, privilege],
  );
  return rows[0]!.ok;
}

async function triggersOf(table: string): Promise<string[]> {
  const { rows } = await t.migratorPool.query<{ tgname: string }>(
    `SELECT tg.tgname FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND NOT tg.tgisinternal`,
    [table],
  );
  return rows.map((r) => r.tgname);
}

describe("catalog", () => {
  it("tests run as the app role", async () => {
    const { rows } = await t.appPool.query("SELECT current_user");
    expect(rows[0].current_user).toBe("diesel_app");
  });

  it("has the core, job order and contract tables", () => {
    expect(tables).toEqual([
      "approvals",
      "attachments",
      "audit_log",
      "contract_vehicles",
      "contracts",
      "contragents",
      "document_counters",
      "document_lines",
      "documents",
      "job_orders",
      "job_status_events",
      "login_attempts",
      "sessions",
      "settings",
      "tablet_devices",
      "user_roles",
      "users",
      "vehicle_plates",
      "vehicles",
    ]);
  });

  it("the app role has no DELETE or TRUNCATE on any table", async () => {
    for (const table of tables) {
      expect(await appHas(table, "DELETE"), `${table} DELETE`).toBe(false);
      expect(await appHas(table, "TRUNCATE"), `${table} TRUNCATE`).toBe(false);
    }
  });

  it("audit_log and job_status_events are SELECT only; attachments are never updated", async () => {
    for (const table of ["audit_log", "job_status_events"]) {
      expect(await appHas(table, "SELECT"), table).toBe(true);
      expect(await appHas(table, "INSERT"), table).toBe(false);
      expect(await appHas(table, "UPDATE"), table).toBe(false);
    }
    expect(await appHas("attachments", "UPDATE")).toBe(false);
    expect(await appHas("settings", "UPDATE")).toBe(false);
    expect(await appHas("login_attempts", "UPDATE")).toBe(false);
    expect(await appHas("approvals", "UPDATE")).toBe(true);
    const { rows } = await t.migratorPool.query(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'diesel_app' AND privilege_type = 'UPDATE'
          AND table_name IN ('audit_log', 'job_status_events', 'attachments', 'settings')`,
    );
    expect(rows).toEqual([]);
  });

  it("the app role cannot create objects or own anything", async () => {
    const { rows } = await t.migratorPool.query(
      `SELECT has_schema_privilege('diesel_app', 'public', 'CREATE') AS can_create,
              (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                WHERE r.rolname = 'diesel_app') AS owned`,
    );
    expect(rows[0]).toEqual({ can_create: false, owned: 0 });
  });

  it("every table forbids DELETE and TRUNCATE by trigger, for any role", async () => {
    for (const table of tables) {
      const triggers = await triggersOf(table);
      expect(triggers, table).toContain("forbid_delete");
      expect(triggers, table).toContain("forbid_truncate");
    }
  });

  it("every table stamps created_* and every business table is audited", async () => {
    for (const table of tables) {
      const triggers = await triggersOf(table);
      // Append-only logs have `at` instead of created_*; counters are not audited.
      if (!APPEND_ONLY.includes(table)) expect(triggers, table).toContain("stamp_created");
      if (![...APPEND_ONLY, ...OPERATIONAL, "document_counters"].includes(table)) {
        expect(triggers, table).toContain("audit_row");
      }
    }
  });

  it("locked rows have their guard triggers", async () => {
    expect(await triggersOf("documents")).toContain("documents_guard");
    expect(await triggersOf("document_lines")).toContain("document_lines_guard");
    expect(await triggersOf("audit_log")).toContain("forbid_update");
    expect(await triggersOf("attachments")).toContain("forbid_update");
    expect(await triggersOf("document_counters")).toContain("document_counters_guard");
    expect(await triggersOf("job_status_events")).toEqual(
      expect.arrayContaining(["forbid_update", "job_status_events_from_trigger"]),
    );
    expect(await triggersOf("job_orders")).toEqual(
      expect.arrayContaining([
        "job_orders_guard",
        "job_status_event_insert",
        "job_status_event_update",
      ]),
    );
    expect(await triggersOf("contracts")).toContain("contracts_guard");
    expect(await triggersOf("contract_vehicles")).toContain("contract_vehicles_guard");
    expect(await triggersOf("documents")).toContain("documents_job_vehicle");
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const { rows } = await t.migratorPool.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
      "audit_row",
      "job_status_event",
      "log_denied",
    ]);
    for (const r of rows) {
      expect(
        r.proconfig?.some((c) => c.startsWith("search_path=")),
        r.proname,
      ).toBe(true);
    }
  });
});
