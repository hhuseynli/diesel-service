import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { Plate } from "@/app/_ui/Plate";
import { TabletBar } from "@/app/_ui/TabletBar";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/db/uuid";
import { vehicleSummary } from "@/lib/intake/queries";
import { reprintStickerAction } from "../../actions";

// A new sticker for a lost or damaged one (spec 01, 3.2, section 4): the old token is
// marked REPLACED with the reason, so a scan of it warns; then the new one prints.
export default async function ReprintPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string; back?: string; e?: string }>;
}) {
  await requireSessionUser();
  const { v, back, e } = await searchParams;
  if (!isUuid(v)) notFound();
  const vehicle = await vehicleSummary(getDb(), v);
  if (!vehicle) notFound();
  const t = await getTranslations("sticker");
  const tu = await getTranslations("ui");
  const backHref = back && /^\/(is\/|qebul\?)/.test(back) ? back : "/isler";
  return (
    <>
      <TabletBar back={{ href: backHref, label: tu("back") }} title={t("reprintTitle")} />
      <main className="frame">
        <form action={reprintStickerAction} className="main">
          <input type="hidden" name="vehicleId" value={vehicle.id} />
          <input type="hidden" name="back" value={backHref} />
          <section className="sticker-stage">
            <span className="h-card">
              {[vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.vin}
            </span>
            <Plate plate={vehicle.plate} vin={vehicle.vin} size="lg" />
          </section>
          <section className="panel">
            <ErrorNote code={e} />
            <Notice kind="warn" title={t("reprintWarnTitle")}>
              {t("reprintWarnBody")}
            </Notice>
            <div className="field">
              <label htmlFor="reason">{t("reason")}</label>
              <input
                id="reason"
                className="input"
                name="reason"
                required
                placeholder={t("reasonPlaceholder")}
              />
            </div>
            <span className="spacer" />
            <button type="submit" className="btn primary lg block">
              <Icon name="printer" />
              {t("reprintSubmit")}
            </button>
          </section>
        </form>
      </main>
    </>
  );
}
