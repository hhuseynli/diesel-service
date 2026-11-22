import { getTranslations } from "next-intl/server";

// Placeholder only: proves the translation setup and Playwright work.
export default async function HomePage() {
  const t = await getTranslations("home");
  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
    </main>
  );
}
