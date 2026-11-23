import type { SignInStatus } from "@/lib/auth";

// Sign-in errors arrive as ?e=<status>; only known statuses are shown (messages/az.json).
const KNOWN: SignInStatus[] = [
  "INVALID",
  "LOCKED",
  "TOTP_REQUIRED",
  "TOTP_NOT_ENROLLED",
  "UNKNOWN_DEVICE",
  "NOT_ALLOWED",
];

export function signInError(e: string | undefined): SignInStatus | undefined {
  return KNOWN.find((k) => k === e);
}
