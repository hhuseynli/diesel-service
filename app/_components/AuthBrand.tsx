import { getTranslations } from "next-intl/server";
import { Icon } from "./Icon";

/** The brand block on the sign-in screens. */
export async function AuthBrand() {
  const t = await getTranslations("app");
  return (
    <div className="auth-brand">
      <span className="brand-mark" aria-hidden="true">
        <Icon name="truck" size={26} />
      </span>
      <span>
        <strong>{t("brand")}</strong>
        <small>{t("tagline")}</small>
      </span>
    </div>
  );
}
