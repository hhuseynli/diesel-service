import { getTranslations } from "next-intl/server";
import { Brand } from "@/app/_ui/Brand";
import { Notice } from "@/app/_ui/Notice";
import { signInAction } from "../actions";
import { signInError } from "../sign-in-errors";

// Office sign-in: phone and password, plus a TOTP code for management and the owner.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const t = await getTranslations("auth");
  const error = signInError((await searchParams).e);
  return (
    <main className="screen">
      <div className="centered">
        <form action={signInAction} className="card narrow left">
          <Brand large />
          <h1 className="h-screen">{t("signInTitle")}</h1>
          {error && <Notice kind="error" role="alert" title={t(`errors.${error}`)} />}
          <div className="field">
            <label htmlFor="phone">{t("phone")}</label>
            <input
              id="phone"
              className="input"
              name="phone"
              type="tel"
              autoComplete="username"
              required
              placeholder={t("phonePlaceholder")}
            />
          </div>
          <div className="field">
            <label htmlFor="password">{t("password")}</label>
            <input
              id="password"
              className="input"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="totp">{t("totp")}</label>
            <input
              id="totp"
              className="input mono"
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
            />
          </div>
          <button type="submit" className="btn primary lg block">
            {t("signIn")}
          </button>
        </form>
      </div>
    </main>
  );
}
