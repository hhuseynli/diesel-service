import { useTranslations } from "next-intl";
import { Notice } from "./Notice";

/** The refusal an action sent back as `?e=<key>`, from the `errors` messages. */
export function ErrorNote({ code }: { code?: string }) {
  const t = useTranslations("errors");
  if (!code) return null;
  return <Notice kind="error" role="alert" title={t.has(code) ? t(code) : t("generic")} />;
}
