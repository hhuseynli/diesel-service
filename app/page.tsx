import { and, eq, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { userRoles, users } from "@/db/schema";
import { getDeviceToken, getSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { odometerAlerts } from "@/lib/intake/queries";
import { groupThousands } from "@/lib/money";
import type { Role } from "@/lib/users/roles";
import { registerTabletAction, signOutAction } from "./actions";

// Signed-in home: who is signed in, their roles, the job board, sign-out; for management
// the tablet registration, and for the owner the odometer alerts (plan 04, B6).
export default async function HomePage() {
  const user = await getSessionUser();
  const onTablet = Boolean(await getDeviceToken());
  if (!user) redirect(onTablet ? "/pin" : "/giris");

  const t = await getTranslations("home");
  const tr = await getTranslations("roles");
  const db = getDb();
  const [me] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, user.userId));
  const roles = (
    await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.userId), isNull(userRoles.revokedAt)))
  ).map((r) => r.role as Role);
  const canRegister = roles.includes("MANAGEMENT") || roles.includes("OWNER");
  const alerts = roles.includes("OWNER") ? await odometerAlerts(db) : [];

  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("signedInAs", { name: me!.name })}</p>
      <p>{t("roles", { roles: roles.map((r) => tr(r)).join(", ") })}</p>
      <Link href="/isler">{t("openBoard")}</Link>
      {alerts.length > 0 && (
        <section>
          <h2>{t("odometerAlerts")}</h2>
          <ul>
            {alerts.map((a) => {
              const values = { number: a.number, vin: a.vin, km: groupThousands(a.valueKm) };
              return (
                <li key={a.jobId}>
                  <Link href={`/is/${a.jobId}`}>
                    {a.belowPrevious
                      ? t("odometerLower", { ...values, reason: a.reason ?? "" })
                      : t("odometerHigh", values)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <form action={signOutAction}>
        <button type="submit">{onTablet ? t("switchUser") : t("signOut")}</button>
      </form>
      {onTablet ? (
        <p>{t("tabletRegistered")}</p>
      ) : (
        canRegister && (
          <form action={registerTabletAction}>
            <label>
              {t("tabletName")}
              <input name="name" required />
            </label>
            <button type="submit">{t("registerTablet")}</button>
          </form>
        )
      )}
    </main>
  );
}
