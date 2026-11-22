import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations run as the migration role, never as the app role.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  strict: true,
  verbose: true,
});
