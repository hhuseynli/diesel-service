import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import type { Tx } from "@/lib/db/types";
import { validateSession, withSessionUser, type SessionUser } from "./index";

// Request context for screens and server actions. The acting user always comes from the
// server-side session, never from the request body (plan 03, A8; R11, AC5).

export const SESSION_COOKIE = "ds_session";
export const DEVICE_COOKIE = "ds_device";

const secure = process.env.NODE_ENV === "production";

/**
 * The signed-in user, checked once per request: the bar and the page both ask, and two
 * checks at once would both try to end an idle session.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? validateSession(getDb(), token, store.get(DEVICE_COOKIE)?.value) : null;
});

/**
 * The signed-in user, or a redirect to sign-in. Every screen that reads data calls this
 * itself: a layout's check does not guard the page, which Next renders in parallel.
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/");
  return user;
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

/** Runs fn as the signed-in user, in one audited transaction (AC5). */
export async function withSessionActor<T>(
  fn: (tx: Tx, user: SessionUser) => Promise<T>,
  reason?: string,
): Promise<T> {
  const store = await cookies();
  return withSessionUser(
    getDb(),
    { token: store.get(SESSION_COOKIE)?.value, deviceToken: store.get(DEVICE_COOKIE)?.value },
    fn,
    reason,
  );
}
