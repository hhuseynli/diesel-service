// Rebuilds the e2e database before the Playwright web server starts: migrations, then
// known test staff (e2e/fixtures.ts). Runs as the migration role, like a seed.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { encryptSecret, hashSecret } from "@/lib/auth/crypto";
import {
  CASHIER,
  E2E_DB,
  FORMEN,
  IDLE_SECONDS,
  MANAGER,
  MECHANIC,
  WAREHOUSE,
  withDatabase,
} from "./fixtures";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";
const migratorUrl = process.env.MIGRATION_DATABASE_URL;
if (!migratorUrl) throw new Error("MIGRATION_DATABASE_URL is not set");

async function main() {
  const admin = new Client({ connectionString: migratorUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${E2E_DB}"`);
  await admin.end();

  const client = new Client({ connectionString: withDatabase(migratorUrl!, E2E_DB) });
  await client.connect();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: "db/migrations",
      migrationsSchema: "drizzle",
    });
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.reason', 'e2e seed', true)",
      [SYSTEM_USER_ID],
    );
    const add = async (
      name: string,
      phone: string,
      role: string,
      extra: Record<string, string>,
    ) => {
      const cols = ["full_name", "phone", ...Object.keys(extra)];
      const values = [name, phone, ...Object.values(extra)];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        values,
      );
      await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [
        rows[0]!.id,
        role,
      ]);
    };
    await add(CASHIER.name, CASHIER.phone, "CASHIER", {
      password_hash: hashSecret(CASHIER.password),
    });
    await add(MANAGER.name, MANAGER.phone, "MANAGEMENT", {
      password_hash: hashSecret(MANAGER.password),
      totp_secret_enc: encryptSecret(MANAGER.totpSecret),
    });
    await add(FORMEN.name, FORMEN.phone, "FORMEN", { pin_hash: hashSecret(FORMEN.pin) });
    await add(WAREHOUSE.name, WAREHOUSE.phone, "WAREHOUSEMAN", {});
    await add(MECHANIC.name, MECHANIC.phone, "MECHANIC", {});
    await client.query("INSERT INTO settings (key, value) VALUES ('tablet_idle_seconds', $1)", [
      JSON.stringify(IDLE_SECONDS),
    ]);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
