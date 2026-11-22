import { getTranslations } from "next-intl/server";

/** The refusal an action sent back as `?e=<key>`, from the `errors` messages. */
export async function ErrorNote({ code }: { code?: string }) {
  if (!code) return null;
  const t = await getTranslations("errors");
  return <p role="alert">{t.has(code) ? t(code) : t("generic")}</p>;
}
