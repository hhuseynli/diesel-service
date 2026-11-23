import { useTranslations } from "next-intl";
import type { JobStatus } from "@/lib/jobs/types";
import { Icon, type IconName } from "./Icon";

// 12 statuses in 7 colour families, each with its own icon (Dizayn sistemi · Status).

export const STATUS_FAMILY: Record<JobStatus, string> = {
  QEBUL: "intake",
  BAXIS: "office",
  QIYMETLENDIRME: "office",
  TESDIQ_GOZLEYIR: "waiting",
  HISSE_GOZLEYIR: "waiting",
  TESDIQLENDI: "work",
  TEMIRDE: "work",
  HAZIR: "ready",
  TEHVIL_VERILDI: "done",
  ODENILDI: "done",
  BAGLANDI: "done",
  LEGV: "cancel",
};

const STATUS_ICON: Record<JobStatus, IconName> = {
  QEBUL: "inbox",
  BAXIS: "search",
  QIYMETLENDIRME: "calc",
  TESDIQ_GOZLEYIR: "pen",
  TESDIQLENDI: "ok",
  HISSE_GOZLEYIR: "box",
  TEMIRDE: "wrench",
  HAZIR: "flag",
  TEHVIL_VERILDI: "key",
  ODENILDI: "cash",
  BAGLANDI: "lock",
  LEGV: "cross",
};

export function StatusBadge({
  status,
  size = "md",
  testId,
}: {
  status: JobStatus;
  size?: "sm" | "md" | "lg";
  testId?: string;
}) {
  const t = useTranslations("status");
  return (
    <span className={`status ${size} fam-${STATUS_FAMILY[status]}`} data-testid={testId}>
      {size !== "sm" && <Icon name={STATUS_ICON[status]} size={size === "lg" ? 18 : 17} />}
      <span>{t(status)}</span>
    </span>
  );
}
