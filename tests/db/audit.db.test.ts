// Plan 01, P7: every insert and update is attributed and audited (spec 00, section 5.2).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contragents, users } from "@/db/schema";
import { withActor } from "@/lib/audit";
import { ActorRequiredError, ImmutableError, ReasonRequiredError } from "@/lib/db/errors";
import { createUser } from "./fixtures";
import { asActor, createTestDb, sqlstateOf, SYSTEM_USER_ID, type TestDb } from "./helpers";

let t: TestDb;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  t = await createTestDb();
  userId = await createUser(t.migratorPool, { roles: ["WAREHOUSEMAN"] });
  otherUserId = await createUser(t.migratorPool);
});
afterAll(() => t.close());

async function auditRows(table: string, recordId: string) {
  const { rows } = await t.migratorPool.query(
    "SELECT * FROM audit_log WHERE table_name = $1 AND record_id = $2 ORDER BY id",
    [table, recordId],
  );
  return rows;
}

async function newContragent(name = "Test MMC"): Promise<string> {
  const [row] = await withActor(t.db, { userId }, (tx) =>
    tx
      .insert(contragents)
      .values({ kind: "HUQUQI", name, isCustomer: true })
      .returning({ id: contragents.id }),
  );
  return row!.id;
}

describe("audit trail", () => {
  it("an insert writes an audit row with the after values and the user", async () => {
    const id = await newContragent("Audit MMC");
    const rows = await auditRows("contragents", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "INSERT", user_id: userId, before: null });
    expect(rows[0].after).toMatchObject({ id, name: "Audit MMC", created_by: userId });
  });

  it("an update writes before, after, user and reason", async () => {
    const id = await newContragent("Old name");
    await withActor(t.db, { userId, reason: "Adı düzəldildi" }, (tx) =>
      tx.update(contragents).set({ name: "New name" }).where(eq(contragents.id, id)),
    );
    const update = (await auditRows("contragents", id)).find((r) => r.action === "UPDATE");
    expect(update).toMatchObject({ user_id: userId, reason: "Adı düzəldildi" });
    expect(update.before.name).toBe("Old name");
    expect(update.after.name).toBe("New name");
  });

  it("an update without a reason is refused (DM004)", async () => {
    const id = await newContragent();
    await expect(
      withActor(t.db, { userId }, (tx) =>
        tx.update(contragents).set({ name: "X" }).where(eq(contragents.id, id)),
      ),
    ).rejects.toBeInstanceOf(ReasonRequiredError);
  });

  it("an update that changes nothing writes no audit row", async () => {
    const id = await newContragent("Same");
    await withActor(t.db, { userId, reason: "no-op" }, (tx) =>
      tx.update(contragents).set({ name: "Same" }).where(eq(contragents.id, id)),
    );
    expect(await auditRows("contragents", id)).toHaveLength(1);
  });

  it("a write without an acting user is refused (DM003)", async () => {
    expect(
      await sqlstateOf(
        t.appPool.query(
          "INSERT INTO contragents (kind, name, is_customer) VALUES ('FIZIKI', 'X', true)",
        ),
      ),
    ).toBe("DM003");
  });

  it("a deactivated user cannot write (DM003)", async () => {
    const inactive = await createUser(t.migratorPool, { active: false });
    await expect(
      withActor(t.db, { userId: inactive }, (tx) =>
        tx.insert(contragents).values({ kind: "FIZIKI", name: "X", isCustomer: true }),
      ),
    ).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it("the system user cannot act through the app role (DM003)", async () => {
    await expect(
      withActor(t.db, { userId: SYSTEM_USER_ID }, (tx) =>
        tx.insert(contragents).values({ kind: "FIZIKI", name: "X", isCustomer: true }),
      ),
    ).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it("created_at and created_by come from the server, whatever the client sends", async () => {
    const [row] = await withActor(t.db, { userId }, (tx) =>
      tx
        .insert(contragents)
        .values({
          kind: "FIZIKI",
          name: "Backdated",
          isCustomer: true,
          createdAt: new Date("2000-01-01T00:00:00Z"),
          createdBy: otherUserId,
        })
        .returning(),
    );
    expect(row!.createdBy).toBe(userId);
    expect(row!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("created_at cannot be changed later (DM005)", async () => {
    const id = await newContragent();
    await expect(
      withActor(t.db, { userId, reason: "backdate" }, (tx) =>
        tx
          .update(contragents)
          .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
          .where(eq(contragents.id, id)),
      ),
    ).rejects.toBeInstanceOf(ImmutableError);
  });

  it("pin_hash never appears in the audit log; a change is only noted", async () => {
    const id = await createUser(t.migratorPool, { fullName: "PIN İstifadəçi" });
    await withActor(t.db, { userId, reason: "PIN dəyişdi" }, (tx) =>
      tx.update(users).set({ pinHash: "secret-hash-value" }).where(eq(users.id, id)),
    );
    const rows = await auditRows("users", id);
    expect(JSON.stringify(rows)).not.toContain("secret-hash-value");
    expect(JSON.stringify(rows)).not.toContain('pin_hash":');
    expect(rows.at(-1).details).toEqual({ pin_hash_changed: true });
  });

  it("the app role cannot write audit_log directly", async () => {
    expect(
      await sqlstateOf(
        asActor(t.appPool, { userId }, (c) =>
          c.query(
            "INSERT INTO audit_log (table_name, action, user_id) VALUES ('x', 'INSERT', $1)",
            [userId],
          ),
        ),
      ),
    ).toBe("42501");
  });
});
