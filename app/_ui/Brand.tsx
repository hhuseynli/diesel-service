import { useTranslations } from "next-intl";
import { Icon } from "./Icon";

/** The truck mark with "Diesel Motors · Servis idarəetməsi". */
export function Brand({ large = false }: { large?: boolean }) {
  const t = useTranslations("app");
  return (
    <span className={large ? "card-brand" : "brand"}>
      <span className="brand-mark" aria-hidden="true">
        <Icon name="truck" size={24} />
      </span>
      <span className="brand-name">
        <strong>{t("brand")}</strong>
        <small>{t("tagline")}</small>
      </span>
    </span>
  );
}
