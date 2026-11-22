// pnpm db:seed-user --name "<full name>" --phone +994XXXXXXXXX --role CASHIER
// Connects as the migration role (MIGRATION_DATABASE_URL). See lib/users/seed.ts.
import "dotenv/config";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import type { Role } from "@/lib/users/roles";
import { seedUser } from "@/lib/users/seed";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    phone: { type: "string" },
    role: { type: "string" },
  },
});
if (!values.name || !values.phone || !values.role) {
  console.error(
    'usage: pnpm db:seed-user --name "<full name>" --phone +994XXXXXXXXX --role CASHIER',
  );
  process.exit(1);
}
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  console.error("MIGRATION_DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
try {
  const result = await seedUser(pool, {
    fullName: values.name,
    phone: values.phone,
    role: values.role as Role,
  });
  console.log(
    result.created
      ? `db:seed-user: created ${result.id} with role ${values.role}`
      : `db:seed-user: a user with phone ${values.phone} already exists (${result.id}); nothing changed`,
  );
} finally {
  await pool.end();
}
