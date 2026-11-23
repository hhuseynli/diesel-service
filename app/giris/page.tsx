import { getTranslations } from "next-intl/server";
import { signInError } from "../sign-in-errors";
import { signInAction } from "../actions";

// Office sign-in: phone and password, plus a TOTP code for management and the owner.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const t = await getTranslations("auth");
  const error = signInError((await searchParams).e);
  return (
    <main>
      <h1>{t("signInTitle")}</h1>
      {error && <p role="alert">{t(`errors.${error}`)}</p>}
      <form action={signInAction}>
        <label>
          {t("phone")}
          <input
            name="phone"
            type="tel"
            autoComplete="username"
            required
            placeholder={t("phonePlaceholder")}
          />
        </label>
        <label>
          {t("password")}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <label>
          {t("totp")}
          <input name="totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" />
        </label>
        <button type="submit">{t("signIn")}</button>
      </form>
    </main>
  );
}
