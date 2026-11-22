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
import { AuthBrand } from "./_components/AuthBrand";
import { Icon } from "./_components/Icon";
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
    <div className="home">
      <main>
        <AuthBrand />
        <section className="card">
          <div className="home-hero">
            <span className="avatar" aria-hidden="true">
              {me!.name.slice(0, 1)}
            </span>
            <div>
              <h1>{t("signedInAs", { name: me!.name })}</h1>
              <p className="muted">{t("roles", { roles: roles.map((r) => tr(r)).join(", ") })}</p>
            </div>
          </div>
          <Link href="/isler" className="btn primary large block">
            <Icon name="board" />
            {t("openBoard")}
          </Link>
        </section>
        {alerts.length > 0 && (
          <section className="card">
            <h2 className="card-head">
              <Icon name="gauge" />
              {t("odometerAlerts")}
              <span className="count">{alerts.length}</span>
            </h2>
            <ul className="results">
              {alerts.map((a) => {
                const values = { number: a.number, vin: a.vin, km: groupThousands(a.valueKm) };
                return (
                  <li key={a.jobId}>
                    <Link href={`/is/${a.jobId}`}>
                      <Icon name="alert" />
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
        {onTablet ? (
          <p className="notice info">
            <Icon name="check" />
            {t("tabletRegistered")}
          </p>
        ) : (
          canRegister && (
            <section className="card">
              <form action={registerTabletAction}>
                <div className="inline">
                  <label>
                    {t("tabletName")}
                    <input name="name" required />
                  </label>
                  <button type="submit">{t("registerTablet")}</button>
                </div>
              </form>
            </section>
          )
        )}
        <form action={signOutAction} className="quiet">
          <button type="submit" className="btn subtle">
            <Icon name="switch" size={18} />
            {onTablet ? t("switchUser") : t("signOut")}
          </button>
        </form>
      </main>
    </div>
  );
}
