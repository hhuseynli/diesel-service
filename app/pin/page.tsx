import { getTranslations } from "next-intl/server";
import { signInError } from "../sign-in-errors";
import Link from "next/link";
import { pinCandidates } from "@/lib/auth";
import { getDeviceToken } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { pinAction } from "../actions";
import { AuthBrand } from "../_components/AuthBrand";

// The shared tablet: pick yourself, enter your PIN (spec 01, section 1).
export default async function PinPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const t = await getTranslations("auth");
  const error = signInError((await searchParams).e);
  if (!(await getDeviceToken())) {
    return (
      <div className="auth">
        <main className="auth-card">
          <AuthBrand />
          <h1>{t("pinTitle")}</h1>
          <p role="alert">{t("notTablet")}</p>
          <Link href="/giris" className="btn large">
            {t("officeLink")}
          </Link>
        </main>
      </div>
    );
  }
  const staff = await pinCandidates(getDb());
  return (
    <div className="auth">
      <main className="auth-card">
        <AuthBrand />
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
              className="pin-input"
              required
            />
          </label>
          <button type="submit" className="primary large">
            {t("pin")}
          </button>
        </form>
      </main>
    </div>
  );
}
