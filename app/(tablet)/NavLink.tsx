"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/app/_components/Icon";

/** A tab in the app bar, marked current while its section is open. */
export function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: IconName;
  children: ReactNode;
}) {
  const path = usePathname();
  const current = path === href || (href === "/isler" && path.startsWith("/is/"));
  return (
    <Link href={href} className="tab" aria-current={current ? "page" : undefined}>
      <Icon name={icon} size={18} />
      {children}
    </Link>
  );
}
