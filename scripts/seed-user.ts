// pnpm db:seed-user --name "<full name>" --phone +994XXXXXXXXX --role OWNER [--set-password] [--enrol-totp]
// Connects as the migration role (MIGRATION_DATABASE_URL). See lib/users/seed.ts.
// --set-password asks for the password (never on the command line, so not in shell
// history); --enrol-totp prints the authenticator secret once. This is how the first
// owner gets in: management and the owner need both (plan 03, A6).
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
    "set-password": { type: "boolean" },
    "enrol-totp": { type: "boolean" },
  },
});

/** Reads a line from the terminal without echoing it. */
async function askHidden(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => {
    if (s.startsWith(question)) out.output.write(s);
  };
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    }),
  );
}
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
    password: values["set-password"] ? await askHidden("Password: ") : undefined,
    enrolTotp: values["enrol-totp"],
  });
  console.log(
    result.created
      ? `db:seed-user: created ${result.id} with role ${values.role}`
      : `db:seed-user: a user with phone ${values.phone} already exists (${result.id}); nothing changed`,
  );
  if (result.totpSecret) {
    console.log(
      `TOTP secret (add it to the authenticator app now; it is not shown again): ${result.totpSecret}`,
    );
    console.log(
      `otpauth://totp/Highest%20Service:${encodeURIComponent(values.phone)}?secret=${result.totpSecret}&issuer=Highest%20Service`,
    );
  }
} finally {
  await pool.end();
}
