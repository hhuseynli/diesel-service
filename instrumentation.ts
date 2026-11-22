// Runs once when the server starts (Next.js instrumentation). Production refuses to
// start without a valid AUTH_SECRET instead of failing at the first sign-in (plan 03, A10).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { authSecret } = await import("./lib/auth/crypto");
    authSecret();
  }
}
