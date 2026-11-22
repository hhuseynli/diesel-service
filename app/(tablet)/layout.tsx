import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/context";
import { signOutAction } from "../actions";

// The formen's tablet screens (plan 04, B12). Every page here needs a signed-in user;
// what each user may do is checked again in the actions (lib/permissions).
export default async function TabletLayout({ children }: { children: ReactNode }) {
  if (!(await getSessionUser())) redirect("/");
  const t = await getTranslations("board");
  const th = await getTranslations("home");
  return (
    <div className="tablet">
      <nav className="no-print">
        <Link href="/isler">{t("title")}</Link>
        <Link href="/qebul">{t("receive")}</Link>
        <form action={signOutAction}>
          <button type="submit">{th("switchUser")}</button>
        </form>
      </nav>
      {children}
    </div>
  );
}
