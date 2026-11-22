// Plan 01, P16: the cashier (or any staff member) is seeded as a personal, audited account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedUser } from "@/lib/users/seed";
import { createTestDb, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

describe("seedUser", () => {
  it("creates the user and the role, audited with the system user as actor", async () => {
    const result = await seedUser(t.migratorPool, {
      fullName: "Kassir Test",
      phone: "+994501234567",
      role: "CASHIER",
    });
    expect(result.created).toBe(true);

    const { rows: roles } = await t.migratorPool.query(
      `SELECT u.full_name, u.is_active, u.pin_hash, r.role
         FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.id = $1`,
      [result.id],
    );
    expect(roles).toEqual([
      { full_name: "Kassir Test", is_active: true, pin_hash: null, role: "CASHIER" },
    ]);

    const { rows: audit } = await t.migratorPool.query(
      `SELECT table_name, action, user_id, reason FROM audit_log
        WHERE record_id = $1 OR after->>'user_id' = $1::text ORDER BY id`,
      [result.id],
    );
    expect(audit).toEqual([
      { table_name: "users", action: "INSERT", user_id: SYSTEM_USER_ID, reason: "audit.seedUser" },
      {
        table_name: "user_roles",
        action: "INSERT",
        user_id: SYSTEM_USER_ID,
        reason: "audit.seedUser",
      },
    ]);
  });

  it("running it again for the same phone changes nothing", async () => {
    const input = { fullName: "Təkrar", phone: "+994507654321", role: "CASHIER" as const };
    const first = await seedUser(t.migratorPool, input);
    const second = await seedUser(t.migratorPool, input);
    expect(second).toEqual({ id: first.id, created: false });
    const { rows } = await t.migratorPool.query(
      "SELECT count(*)::int AS n FROM users WHERE phone = $1",
      [input.phone],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses bad input", async () => {
    await expect(
      seedUser(t.migratorPool, { fullName: "X", phone: "0501234567", role: "CASHIER" }),
    ).rejects.toThrow(RangeError);
    await expect(
      seedUser(t.migratorPool, { fullName: " ", phone: "+994501111111", role: "CASHIER" }),
    ).rejects.toThrow(RangeError);
  });
});
