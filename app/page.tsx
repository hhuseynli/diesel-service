import { and, eq, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { userRoles, users } from "@/db/schema";
import { getDeviceToken, getSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import type { Role } from "@/lib/users/roles";
import { registerTabletAction, signOutAction } from "./actions";

// Signed-in placeholder until the module screens (milestone 4): who is signed in, their
// roles, sign-out, and for management the tablet registration.
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

  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("signedInAs", { name: me!.name })}</p>
      <p>{t("roles", { roles: roles.map((r) => tr(r)).join(", ") })}</p>
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
