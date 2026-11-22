import type { Pool, PoolClient } from "pg";
import { encryptSecret, hashSecret, newTotpSecret } from "@/lib/auth/crypto";
import { ROLES, type Role } from "./roles";

// Creates a real staff member's account before user management exists (milestone 3).
// Runs as the migration role with the system actor, like a seed, so the audit log shows
// who created the account. Personal data comes from the command line, never from git
// (plan 01, Q5; R20). Every person gets their own account (R11).

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

export interface SeedUserInput {
  fullName: string;
  phone: string;
  role: Role;
  /** Office password (at least 10 characters); never passed on the command line. */
  password?: string;
  /** Enrol a TOTP authenticator; its secret is returned once (plan 03, A6). */
  enrolTotp?: boolean;
}

export interface SeedUserResult {
  id: string;
  created: boolean;
  totpSecret?: string;
}

export async function seedUser(pool: Pool, input: SeedUserInput): Promise<SeedUserResult> {
  if (input.fullName.trim() === "") throw new RangeError("A full name is required");
  if (!/^\+[0-9]{8,15}$/.test(input.phone)) {
    throw new RangeError(`Phone "${input.phone}" must look like +994501234567`);
  }
  if (!ROLES.includes(input.role)) throw new RangeError(`Unknown role "${input.role}"`);

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.reason', 'audit.seedUser', true)",
      [SYSTEM_USER_ID],
    );
    const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE phone = $1", [
      input.phone,
    ]);
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return { id: existing.rows[0].id, created: false };
    }
    if (input.password !== undefined && input.password.length < 10) {
      throw new RangeError("A password is at least 10 characters");
    }
    const totpSecret = input.enrolTotp ? newTotpSecret() : undefined;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, phone, password_hash, totp_secret_enc)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        input.fullName.trim(),
        input.phone,
        input.password ? hashSecret(input.password) : null,
        totpSecret ? encryptSecret(totpSecret) : null,
      ],
    );
    const id = rows[0]!.id;
    await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, $2)", [id, input.role]);
    await client.query("COMMIT");
    return { id, created: true, totpSecret };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
