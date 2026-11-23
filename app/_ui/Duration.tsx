import { useTranslations } from "next-intl";
import { durationParts } from "@/lib/format";

/** "35 dəq", "5 saat 20 dəq", "1 gün 4 saat". */
export function Duration({ minutes }: { minutes: number }) {
  const t = useTranslations("ui.duration");
  const { key, values } = durationParts(minutes);
  return <>{t(key, values)}</>;
}
