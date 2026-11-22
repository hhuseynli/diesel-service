import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { users } from "@/db/schema";
import { getDeviceToken } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { pinAction } from "../actions";

// The shared tablet: pick yourself, enter your PIN (spec 01, section 1).
export default async function PinPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const t = await getTranslations("auth");
  const { e } = await searchParams;
  if (!(await getDeviceToken())) {
    return (
      <main>
        <h1>{t("pinTitle")}</h1>
        <p role="alert">{t("notTablet")}</p>
        <Link href="/giris">{t("officeLink")}</Link>
      </main>
    );
  }
  const staff = await getDb()
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(and(eq(users.isActive, true), isNotNull(users.pinHash), isNull(users.lockedAt)))
    .orderBy(asc(users.fullName));
  return (
    <main>
      <h1>{t("pinTitle")}</h1>
      {e && <p role="alert">{t(`errors.${e}` as "errors.INVALID")}</p>}
      <form action={pinAction}>
        <label>
          {t("who")}
          <select name="userId" required>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("pin")}
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4,6}"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit">{t("pin")}</button>
      </form>
    </main>
  );
}
