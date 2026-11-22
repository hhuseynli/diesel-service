import "server-only";
import { cookies } from "next/headers";
import { withActor } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import type { Tx } from "@/lib/db/types";
import { validateSession, type SessionUser } from "./index";

// Request context for screens and server actions. The acting user always comes from the
// server-side session, never from the request body (plan 03, A8; R11, AC5).

export const SESSION_COOKIE = "ds_session";
export const DEVICE_COOKIE = "ds_device";

const secure = process.env.NODE_ENV === "production";

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? validateSession(getDb(), token) : null;
}

export async function getDeviceToken(): Promise<string | undefined> {
  return (await cookies()).get(DEVICE_COOKIE)?.value;
}

/** Sets the session cookie; only in server actions or route handlers. */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Marks this browser as a registered shared tablet (long-lived). */
export async function setDeviceCookie(token: string): Promise<void> {
  (await cookies()).set(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 365 * 5,
  });
}

export class NotSignedInError extends Error {}

/** Runs fn as the signed-in user, in one audited transaction. */
export async function withSessionActor<T>(
  fn: (tx: Tx, user: SessionUser) => Promise<T>,
  reason?: string,
): Promise<T> {
  const user = await getSessionUser();
  if (!user) throw new NotSignedInError("Not signed in");
  return withActor(getDb(), { userId: user.userId, reason }, (tx) => fn(tx, user));
}
