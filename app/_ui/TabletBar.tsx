import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { signOutAction } from "@/app/actions";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { staffMember } from "@/lib/intake/queries";
import { Brand } from "./Brand";
import { Icon } from "./Icon";

/**
 * The tablet's top bar: the brand on the board, else a back link and the screen title;
 * then the person signed in and "Dəyiş" (lock, the next person switches in by PIN).
 */
export async function TabletBar({
  back,
  title,
  children,
}: {
  back?: { href: string; label: string };
  title?: string;
  children?: ReactNode;
}) {
  const user = await requireSessionUser();
  const me = await staffMember(getDb(), user.userId);
  const t = await getTranslations("ui");
  const tr = await getTranslations("roles");
  return (
    <header className="bar no-print">
      {back ? (
        <>
          <Link href={back.href} className="bar-back">
            <Icon name="back" size={24} stroke={2.2} />
            {back.label}
          </Link>
          <span className="bar-sep" aria-hidden="true" />
          {title && <h1 className="bar-title">{title}</h1>}
        </>
      ) : (
        <Link href="/isler" aria-label={t("toBoard")}>
          <Brand />
        </Link>
      )}
      <span className="bar-spacer" />
      {children}
      {children && <span className="bar-sep" aria-hidden="true" />}
      <span className="avatar" aria-hidden="true">
        {me.name.slice(0, 1)}
      </span>
      <span className="who">
        <strong>{me.name}</strong>
        {me.role && <small>{tr(me.role)}</small>}
      </span>
      <form action={signOutAction}>
        <button type="submit" className="btn neutral sm">
          <Icon name="lock" size={18} />
          {t("lock")}
        </button>
      </form>
    </header>
  );
}
