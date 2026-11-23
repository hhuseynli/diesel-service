import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { Plate } from "@/app/_ui/Plate";
import { QrScanner } from "@/app/_ui/QrScanner";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { getDb } from "@/lib/db/client";
import { formatDate } from "@/lib/format";
import { searchByPlate } from "@/lib/vehicles";
import { identifyByQr, identifyByVin } from "../actions";
import { href, type Params } from "./params";

const MODES = ["code", "vin", "plate"] as const;

/** 2.1 Maşını tap: scan the sticker, or find the car by sticker code, VIN or plate. */
export async function Identify({ params }: { params: Params }) {
  const t = await getTranslations("intake");
  const tu = await getTranslations("ui");
  const mode = (MODES as readonly string[]).includes(params.m ?? "") ? params.m! : "code";
  // The plate is only a shortcut: every result leads to a VIN, and former plates say so.
  const plates = mode === "plate" && params.pl ? await searchByPlate(getDb(), params.pl) : [];

  return (
    <>
      <TabletBar back={{ href: "/isler", label: tu("board") }} title={t("title")} />
      <StepBar step={1} />
      <main className="main even">
        <form id="scan-form" action={identifyByQr} className="scan-form">
          <input type="hidden" name="token" />
          <QrScanner
            formId="scan-form"
            inputName="token"
            title={t("scanTitle")}
            sub={t("scanSub")}
            startLabel={t("scanStart")}
            unsupported={t("scanUnsupported")}
          />
        </form>
        <section className="panel">
          <h2 className="h-card">{t("manualTitle")}</h2>
          <nav className="chips" aria-label={t("manualTitle")}>
            {MODES.map((m) => (
              <Link
                key={m}
                href={href({ m })}
                className="chip sm"
                aria-current={m === mode ? "true" : undefined}
              >
                <Icon name="check" size={16} stroke={2.4} />
                {t(`mode.${m}`)}
              </Link>
            ))}
          </nav>
          <ErrorNote code={params.e} />

          {mode === "code" && (
            <form action={identifyByQr} className="inline">
              <label className="search">
                <Icon name="search" size={22} />
                <input
                  className="input mono"
                  name="token"
                  aria-label={t("searchCode")}
                  required
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="btn outline">
                {t("find")}
              </button>
            </form>
          )}

          {mode === "vin" && (
            <form action={identifyByVin} className="field">
              <div className="inline">
                <label className="search">
                  <Icon name="search" size={22} />
                  <input
                    className="input mono"
                    name="vin"
                    aria-label={t("searchVin")}
                    required
                    maxLength={17}
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                </label>
                <button type="submit" className="btn outline">
                  {t("find")}
                </button>
              </div>
              <span className="small muted">{t("vinHint")}</span>
            </form>
          )}

          {mode === "plate" && (
            <>
              <form action="/qebul" className="inline">
                <input type="hidden" name="m" value="plate" />
                <label className="search">
                  <Icon name="search" size={22} />
                  <input
                    className="input mono"
                    name="pl"
                    defaultValue={params.pl}
                    aria-label={t("searchPlate")}
                    required
                    autoCapitalize="characters"
                  />
                </label>
                <button type="submit" className="btn outline">
                  {t("find")}
                </button>
              </form>
              {params.pl && plates.length === 0 && (
                <Notice title={t("notFoundTitle", { q: params.pl })}>{t("notFoundBody")}</Notice>
              )}
              {plates.length > 0 && (
                <span className="small muted">{t("plateResults", { n: plates.length })}</span>
              )}
              <ul className="col">
                {plates.map((r) => {
                  const former = r.label === "FORMER";
                  const body = (
                    <span className="result-body">
                      <strong>{[r.make, r.model].filter(Boolean).join(" ") || r.vin}</strong>
                      <Plate
                        plate={r.plateDisplay}
                        vin={r.vin}
                        formerUntil={former && r.usedUntil ? formatDate(r.usedUntil) : undefined}
                      />
                      {former && r.usedUntil && (
                        <span className="small muted">
                          {t("plateMoved", { date: formatDate(r.usedUntil) })}
                        </span>
                      )}
                      {r.label === "UNCONFIRMED" && (
                        <span className="small muted">{t("plateUnconfirmed")}</span>
                      )}
                    </span>
                  );
                  return (
                    <li key={`${r.vehicleId}-${r.plateDisplay}-${r.validFrom}`}>
                      <Link className="result" href={href({ v: r.vehicleId })}>
                        {body}
                        <Icon name="next" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <span className="spacer" />
          <div className="panel-foot">
            <span className="muted">{t("noStickerQ")}</span>
            <Link href={href({ m: "vin" })} className="btn outline">
              <Icon name="plus" />
              {t("newVehicle")}
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
