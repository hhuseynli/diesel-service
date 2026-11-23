import type { ReactNode } from "react";
import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { DM_Mono, DM_Sans } from "next/font/google";

// The design system's type (Dizayn sistemi): DM Sans for text, DM Mono for VINs, numbers
// and codes. Both cover the Azerbaijani letters through latin-ext.
const sans = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });
const mono = DM_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export async function generateMetadata() {
  const t = await getTranslations("home");
  return { title: t("title") };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${sans.variable} ${mono.variable}`}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
