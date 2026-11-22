import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { users } from "@/db/schema";
import { Icon } from "@/app/_components/Icon";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { signOutAction } from "../actions";
import { NavLink } from "./NavLink";

// The formen's tablet screens (plan 04, B12). Every page here needs a signed-in user;
// what each user may do is checked again in the actions (lib/permissions).
export default async function TabletLayout({ children }: { children: ReactNode }) {
  const session = await requireSessionUser();
  const [me] = await getDb()
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, session.userId));
  const t = await getTranslations("board");
  const ta = await getTranslations("app");
  return (
    <div className="shell">
      <header className="appbar no-print">
        <Link href="/isler" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="truck" size={22} />
          </span>
          <span>
            <strong>{ta("brand")}</strong>
            <small>{ta("tagline")}</small>
          </span>
        </Link>
        <nav className="tabs">
          <NavLink href="/isler" icon="board">
            {t("title")}
          </NavLink>
          <NavLink href="/qebul" icon="plus">
            {t("receive")}
          </NavLink>
        </nav>
        <form action={signOutAction} className="whoami">
          <span className="avatar" aria-hidden="true">
            {me?.name.slice(0, 1)}
          </span>
          <span className="whoami-name">{me?.name}</span>
          <button type="submit" className="btn ghost small" aria-label={ta("switchUser")}>
            <Icon name="switch" size={16} />
            {ta("switchUser")}
          </button>
        </form>
      </header>
      <div className="page">{children}</div>
    </div>
  );
}
