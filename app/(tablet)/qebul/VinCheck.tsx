import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { Plate } from "@/app/_ui/Plate";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { getDb } from "@/lib/db/client";
import { formatDate } from "@/lib/format";
import { lastVisit, type VehicleSummary } from "@/lib/intake/queries";
import { groupThousands } from "@/lib/money";
import { changePlateAction } from "../actions";
import { href, type Params } from "./params";

/**
 * 2.2 VIN yoxlaması: the car's photo from its last visit beside its VIN, the last six
 * characters marked; the formen checks them on the car (spec 01, 3.2; R8). A car still in
 * the workshop leads to its open job once matched.
 */
export async function VinCheck({ params, vehicle }: { params: Params; vehicle: VehicleSummary }) {
  const t = await getTranslations("intake");
  const tu = await getTranslations("ui");
  const last = await lastVisit(getDb(), vehicle.id);
  const self = href(params);
  const matched = params.ok === "1";
  const title = [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.vin;

  return (
    <>
      <TabletBar back={{ href: "/qebul", label: tu("back") }} title={t("vinCheckTitle")} />
      <StepBar step={1} />
      <main className="main wide-left">
        <section className="panel" style={{ padding: 16 }}>
          <span className="last-photo">
            {last?.frontPhotoId ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by /fayl
              <img
                src={`/fayl/${last.frontPhotoId}`}
                alt={t("lastPhotoTag", { date: formatDate(last.at) })}
              />
            ) : (
              <Icon name="image" size={44} stroke={1.6} />
            )}
            <span className="photo-tag">
              {last?.frontPhotoId
                ? t("lastPhotoTag", { date: formatDate(last.at) })
                : t("noLastPhoto")}
            </span>
          </span>
          <span className="h-card">{title}</span>
          <Plate plate={vehicle.plate} vin={vehicle.vin} />
          {last && (
            <span className="small muted">
              {last.km !== null
                ? t("lastClientKm", { client: last.clientName, km: groupThousands(last.km) })
                : last.clientName}
            </span>
          )}
        </section>

        <section className="panel">
          {params.rs && <Notice kind="warn" role="alert" title={t("replacedSticker")} />}
          <ErrorNote code={params.e} />
          {matched && vehicle.openJobId ? (
            <>
              <Notice title={t("openJobExists")} />
              <span className="spacer" />
              <Link className="btn primary lg block" href={`/is/${vehicle.openJobId}`}>
                {t("openJobLink")}
                <Icon name="arrow" />
              </Link>
            </>
          ) : (
            <>
              <h1 className="h-section">{t("vinCheckHeading")}</h1>
              <p className="vin-box" aria-label={vehicle.vin}>
                <span>{vehicle.vin.slice(0, -6)}</span>
                <mark>{vehicle.vin.slice(-6)}</mark>
              </p>
              <span className="muted">{t("vinWhere")}</span>
              {params.ch === "1" ? (
                <form action={changePlateAction} className="field">
                  <input type="hidden" name="v" value={vehicle.id} />
                  <label htmlFor="new-plate">{t("newPlate")}</label>
                  <input
                    id="new-plate"
                    className="input mono"
                    name="plate"
                    required
                    autoCapitalize="characters"
                  />
                  {vehicle.plate && (
                    <span className="small muted">
                      {t("newPlateNote", { plate: vehicle.plate, date: formatDate(new Date()) })}
                    </span>
                  )}
                  <button type="submit" className="btn primary lg block">
                    <Icon name="check" stroke={2.4} />
                    {t("saveAndMatch")}
                  </button>
                </form>
              ) : (
                <>
                  <span className="spacer" />
                  <Link className="btn primary lg block" href={href(params, { ok: "1" })}>
                    <Icon name="check" stroke={2.4} />
                    {t("vinMatches")}
                  </Link>
                  <div className="btn-row">
                    <Link className="btn outline lg" href={href(params, { ch: "1" })}>
                      {t("plateChanged")}
                    </Link>
                    <Link className="btn danger-outline lg" href="/qebul">
                      {t("vinMismatch")}
                    </Link>
                  </div>
                </>
              )}
              <div className="panel-foot">
                <span className="muted">{t("lostSticker")}</span>
                <Link
                  className="btn"
                  href={`/stiker/yeni?v=${vehicle.id}&back=${encodeURIComponent(self)}`}
                >
                  <Icon name="printer" />
                  {t("reprint")}
                </Link>
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}
