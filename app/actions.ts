"use server";

import { redirect } from "next/navigation";
import { registerTablet, signInWithPassword, signInWithPin, signOut } from "@/lib/auth";
import { cookies } from "next/headers";
import {
  clearSessionCookie,
  getDeviceToken,
  SESSION_COOKIE,
  setDeviceCookie,
  setSessionCookie,
  withSessionActor,
} from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";

// Server actions for sign-in. Errors go back as a code in the URL; the page shows the
// translated text (messages/az.json, auth.errors).

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function signInAction(form: FormData) {
  const result = await signInWithPassword(getDb(), {
    phone: text(form, "phone"),
    password: text(form, "password"),
    totpCode: text(form, "totp") || undefined,
  });
  if (result.status !== "OK") redirect(`/giris?e=${result.status}`);
  await setSessionCookie(result.token);
  redirect("/");
}

export async function pinAction(form: FormData) {
  const deviceToken = await getDeviceToken();
  if (!deviceToken) redirect("/pin?e=UNKNOWN_DEVICE");
  const result = await signInWithPin(getDb(), {
    deviceToken,
    userId: text(form, "userId"),
    pin: text(form, "pin"),
  });
  if (result.status !== "OK") redirect(`/pin?e=${result.status}`);
  await setSessionCookie(result.token);
  redirect("/");
}

export async function signOutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await signOut(getDb(), token);
  await clearSessionCookie();
  redirect((await getDeviceToken()) ? "/pin" : "/giris");
}

/** Management registers the browser in use as the shared tablet. */
export async function registerTabletAction(form: FormData) {
  const token = await withSessionActor((tx) => registerTablet(tx, text(form, "name") || "Planşet"));
  await setDeviceCookie(token);
  redirect("/");
}
