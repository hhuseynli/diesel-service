import { getTranslations } from "next-intl/server";
import { signInError } from "../sign-in-errors";
import Link from "next/link";
import { pinCandidates } from "@/lib/auth";
import { getDeviceToken } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { pinAction } from "../actions";

// The shared tablet: pick yourself, enter your PIN (spec 01, section 1).
export default async function PinPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const t = await getTranslations("auth");
  const error = signInError((await searchParams).e);
  if (!(await getDeviceToken())) {
    return (
      <main>
        <h1>{t("pinTitle")}</h1>
        <p role="alert">{t("notTablet")}</p>
        <Link href="/giris">{t("officeLink")}</Link>
      </main>
    );
  }
  const staff = await pinCandidates(getDb());
  return (
    <main>
      <h1>{t("pinTitle")}</h1>
      {error && <p role="alert">{t(`errors.${error}`)}</p>}
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
