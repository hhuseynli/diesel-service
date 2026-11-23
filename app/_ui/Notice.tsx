import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<string, IconName> = {
  info: "info",
  warn: "warn",
  error: "error",
  success: "ok",
};

/** A coloured notice: info (blue), warn (amber), error (red), success (green). */
export function Notice({
  kind = "info",
  title,
  children,
  role,
}: {
  kind?: "info" | "warn" | "error" | "success";
  title: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className={`notice ${kind}`} role={role}>
      <Icon name={ICONS[kind]!} size={22} />
      <div className="notice-body">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
    </div>
  );
}
