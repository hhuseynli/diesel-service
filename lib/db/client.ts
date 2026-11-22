import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import type { Db } from "./types";

let instance: Db | undefined;

/** The application's database, connected as the app role (DATABASE_URL). */
export function getDb(): Db {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    instance = drizzle(new Pool({ connectionString }), { schema });
  }
  return instance;
}
