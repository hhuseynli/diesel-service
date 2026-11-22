import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { migratorUrl, TEMPLATE_DB, TEST_DB_PREFIX, withDatabase } from "./env";

// Builds a fresh template database with every migration applied, as the migration role.
// Each test file copies it (helpers.ts createTestDb), because rows can never be deleted
// and the concurrency tests need committed data, so tests cannot clean up after themselves.
export default async function setup() {
  const admin = new Client({ connectionString: migratorUrl() });
  await admin.connect();
  try {
    // Leftovers from interrupted runs, then the template itself.
    const stale = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1",
      [`${TEST_DB_PREFIX}%`],
    );
    for (const { datname } of stale.rows) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: withDatabase(migratorUrl(), TEMPLATE_DB) });
  await client.connect();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: "db/migrations",
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations",
    });
  } finally {
    await client.end();
  }
}
