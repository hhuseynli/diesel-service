import { useTranslations } from "next-intl";

/**
 * A number plate beside the VIN's last 6 characters (rules: a plate is never shown alone).
 * A former plate is dashed and says until when; no plate shows "Nömrəsiz".
 */
export function Plate({
  plate,
  vin,
  size = "md",
  formerUntil,
  highlight = false,
  showVin = true,
}: {
  plate: string | null;
  vin: string;
  size?: "sm" | "md" | "lg";
  formerUntil?: string;
  highlight?: boolean;
  showVin?: boolean;
}) {
  const t = useTranslations("ui");
  return (
    <span className={`plate-id ${size}`}>
      {plate ? (
        <span className={formerUntil ? "plate former" : "plate"}>
          <span className="plate-az" aria-hidden="true" />
          <span className="plate-num">{plate}</span>
        </span>
      ) : (
        <span className="plate none">{t("noPlate")}</span>
      )}
      {formerUntil && <span className="tiny muted">{t("formerPlate", { date: formerUntil })}</span>}
      {showVin && (
        <span className={highlight ? "vin6 hl" : "vin6"}>
          {t("vinPrefix")}
          <b>{vin.slice(-6)}</b>
        </span>
      )}
    </span>
  );
}
