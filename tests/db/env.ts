// Connection settings for database tests: the same .env as the app.
export const TEMPLATE_DB = "diesel_test_tpl";
export const TEST_DB_PREFIX = "diesel_test_";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; copy .env.example to .env`);
  return value;
}

export const appUrl = () => required("DATABASE_URL");
export const migratorUrl = () => required("MIGRATION_DATABASE_URL");

/** The same server and credentials, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
