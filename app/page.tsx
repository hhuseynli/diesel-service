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
import { Brand } from "./_ui/Brand";
import { Icon } from "./_ui/Icon";
import { Notice } from "./_ui/Notice";
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
    <main className="screen">
      <div className="centered">
        <div className="card left">
          <Brand large />
          <div className="job-vehicle">
            <span className="avatar xl" aria-hidden="true">
              {me!.name.slice(0, 1)}
            </span>
            <span className="who">
              <h1 className="h-screen">{t("signedInAs", { name: me!.name })}</h1>
              <span className="muted">
                {t("roles", { roles: roles.map((r) => tr(r)).join(", ") })}
              </span>
            </span>
          </div>
          <Link href="/isler" className="btn primary lg block">
            <Icon name="board" />
            {t("openBoard")}
          </Link>
          {alerts.length > 0 && (
            <section className="panel tight">
              <span className="panel-head">
                <h2 className="h-panel">{t("odometerAlerts")}</h2>
                <span className="count">{alerts.length}</span>
              </span>
              <ul className="col">
                {alerts.map((a) => {
                  const values = { number: a.number, vin: a.vin, km: groupThousands(a.valueKm) };
                  return (
                    <li key={a.jobId}>
                      <Link className="result" href={`/is/${a.jobId}`}>
                        <Icon name="warn" />
                        <span className="result-body">
                          {a.belowPrevious
                            ? t("odometerLower", { ...values, reason: a.reason ?? "" })
                            : t("odometerHigh", values)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {onTablet ? (
            <Notice kind="success" title={t("tabletRegistered")} />
          ) : (
            canRegister && (
              <form action={registerTabletAction} className="inline">
                <div className="field">
                  <label htmlFor="tabletName">{t("tabletName")}</label>
                  <input id="tabletName" className="input" name="name" required />
                </div>
                <button type="submit" className="btn outline" style={{ alignSelf: "flex-end" }}>
                  {t("registerTablet")}
                </button>
              </form>
            )
          )}
          <form action={signOutAction}>
            <button type="submit" className="btn neutral block">
              <Icon name="lock" size={18} />
              {onTablet ? t("switchUser") : t("signOut")}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
