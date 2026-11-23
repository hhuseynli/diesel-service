import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { createVehicleAction } from "../actions";
import { href, type Params } from "./params";

/**
 * 2.3 Yeni maşın: the VIN just typed, locked, and the car's details by hand (the VIN
 * decoder waits for R19; plan 04, C7). Its sticker prints once the job is opened.
 */
export async function NewVehicle({ params }: { params: Params }) {
  const t = await getTranslations("intake");
  const tu = await getTranslations("ui");
  return (
    <>
      <TabletBar back={{ href: href({ m: "vin" }), label: tu("back") }} title={t("newVehicle")} />
      <StepBar step={1} />
      <main className="frame">
        <form
          action={createVehicleAction}
          className="main"
          style={{ ["--side" as string]: "360px" }}
        >
          <section className="panel">
            <ErrorNote code={params.e} />
            <div className="field">
              <span className="label">{t("searchVin")}</span>
              <span className="vin-locked">
                <Icon name="lock" size={18} />
                {params.nv}
              </span>
              <input type="hidden" name="vin" value={params.nv} />
            </div>
            <Notice title={t("decoderOffTitle")}>{t("decoderOffBody")}</Notice>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="make">{t("make")}</label>
                <input id="make" className="input" name="make" />
              </div>
              <div className="field">
                <label htmlFor="model">{t("model")}</label>
                <input id="model" className="input" name="model" />
              </div>
              <div className="field">
                <label htmlFor="year">{t("year")}</label>
                <input id="year" className="input" name="year" inputMode="numeric" maxLength={4} />
              </div>
              <div className="field">
                <label htmlFor="engine">{t("engine")}</label>
                <input id="engine" className="input" name="engine" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="plate">{t("plate")}</label>
              <input
                id="plate"
                className="input mono"
                name="plate"
                placeholder="90-AA-000"
                autoCapitalize="characters"
                style={{ maxWidth: 260 }}
              />
              <span className="small muted">{t("plateNoneHint")}</span>
            </div>
          </section>
          <section className="panel">
            <h2 className="h-panel">{t("stickerTitle")}</h2>
            <p className="muted">{t("stickerBody")}</p>
            <span className="spacer" />
            <button type="submit" className="btn primary lg block">
              {tu("continue")}
              <Icon name="arrow" />
            </button>
          </section>
        </form>
      </main>
    </>
  );
}
