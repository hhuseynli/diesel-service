"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/app/_ui/Icon";
import { PhotoTile } from "@/app/_ui/PhotoTile";
import { groupThousands as group } from "@/lib/money";
import { uploadIntakePhotos } from "../actions";

const SLOTS = ["ODOMETER", "FRONT", "REAR", "LEFT", "RIGHT", "DASHBOARD"] as const;

/**
 * 3.2 Foto və yürüş (spec 01, 3.4): six camera tiles and the odometer beside them. The
 * reading is compared with the last one as it is typed: lower needs a reason (R9), a jump
 * above the daily limit is flagged. "Davam et" says what is still missing; the server
 * checks the same again.
 */
export function PhotosForm({
  back,
  previous,
  maxPerDay,
}: {
  back: string;
  previous: { km: number; date: string; days: number } | null;
  maxPerDay: number;
}) {
  const t = useTranslations("intake");
  const tu = useTranslations("ui");
  const [taken, setTaken] = useState<Record<string, boolean>>({});
  const [km, setKm] = useState("");
  const [reason, setReason] = useState("");

  const value = /^\d{1,9}$/.test(km.replace(/\s/g, "")) ? Number(km.replace(/\s/g, "")) : null;
  const days = previous?.days ?? 0;
  const low = previous !== null && value !== null && value < previous.km;
  const delta = previous && value !== null ? value - previous.km : 0;
  const perDay = previous && value !== null ? Math.round(delta / days) : 0;
  const high = previous !== null && value !== null && delta > maxPerDay * days;

  const missing = SLOTS.filter((s) => !taken[s]);
  const why =
    missing.length > 0
      ? t("photosMissingWhy", {
          n: SLOTS.length - missing.length,
          missing: missing.map((s) => t(`slot.${s}`)).join(", "),
        })
      : value === null
        ? t("kmMissingWhy")
        : low && reason.trim() === ""
          ? t("reasonMissingWhy")
          : null;

  return (
    <form action={uploadIntakePhotos} className="main" style={{ ["--side" as string]: "400px" }}>
      <input type="hidden" name="back" value={back} />
      <section className="panel" style={{ padding: "20px 24px" }}>
        <span className="panel-head">
          <h1 className="h-card">{t("photosTitle")}</h1>
          <span className="muted num">
            {t("photosCount", { n: SLOTS.length - missing.length })}
          </span>
        </span>
        <div className="tiles">
          {SLOTS.map((slot) => (
            <PhotoTile
              key={slot}
              name={`photo_${slot}`}
              label={t(`slot.${slot}`)}
              hint={tu("tapToShoot")}
              required
              onPick={(n) => setTaken((s) => ({ ...s, [slot]: n > 0 }))}
            />
          ))}
        </div>
        <span className="small muted">{t("photosNote")}</span>
      </section>

      <section className="panel">
        <label htmlFor="km" className="h-panel">
          {t("kmLabel")}
        </label>
        <span className="suffix">
          <input
            id="km"
            name="km"
            className={`input big${low ? " invalid" : high ? " warn" : ""}`}
            inputMode="numeric"
            autoComplete="off"
            required
            value={km}
            onChange={(e) => setKm(e.currentTarget.value.replace(/[^\d\s]/g, ""))}
          />
          <span aria-hidden="true">{tu("kmUnit")}</span>
        </span>
        <span className="muted num">
          {previous ? t("previous", { km: group(previous.km), date: previous.date }) : t("kmFirst")}
        </span>
        {previous && value !== null && !low && !high && (
          <span className="ok-line num">
            <Icon name="ok" size={18} />
            {t("kmOk", { days, delta: group(delta), perDay: group(perDay) })}
          </span>
        )}
        {low && (
          <>
            <div className="notice error" role="alert">
              <Icon name="error" size={22} />
              <div className="notice-body">
                <strong>{t("kmLowTitle")}</strong>
                <span>{t("kmLowBody", { delta: group(-delta) })}</span>
              </div>
            </div>
          </>
        )}
        {high && (
          <div className="notice warn">
            <Icon name="warn" size={22} />
            <div className="notice-body">
              <strong>{t("kmHighTitle", { perDay: group(perDay) })}</strong>
              <span>{t("kmHighBody")}</span>
            </div>
          </div>
        )}
        <div className="field" hidden={!low}>
          <label htmlFor="reason">{t("reasonRequired")}</label>
          <textarea
            id="reason"
            name="reason"
            rows={2}
            className={`textarea${low ? " invalid" : ""}`}
            placeholder={t("reasonPlaceholder")}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </div>
        <span className="spacer" />
        <button
          type="submit"
          className={why ? "btn lg block" : "btn primary lg block"}
          disabled={Boolean(why)}
        >
          {tu("continue")}
          <Icon name="arrow" />
        </button>
        {why && <span className="small muted center">{why}</span>}
      </section>
    </form>
  );
}
