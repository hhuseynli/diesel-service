import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { SignaturePad } from "@/app/_ui/SignaturePad";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { getDb } from "@/lib/db/client";
import { mechanics } from "@/lib/intake/queries";
import { saveIntake } from "../actions";
import { href, type Params } from "./params";

/**
 * 3.3 Şikayət və imza (spec 01, 3.5): the complaint in the client's words, the mechanic,
 * and the person who brought the car signs on screen. "Saxla" opens the job in one
 * transaction (receiveVehicle).
 */
export async function ComplaintsStep({ params }: { params: Params }) {
  const t = await getTranslations("intake");
  const tu = await getTranslations("ui");
  const staff = await mechanics(getDb());
  return (
    <>
      <TabletBar
        back={{
          href: href(params, { p: undefined, km: undefined, r: undefined }),
          label: tu("back"),
        }}
        title={t("title")}
      />
      <StepBar step={4} />
      <main className="frame">
        <form action={saveIntake} className="main even">
          <input type="hidden" name="back" value={href(params)} />
          <section className="panel">
            <ErrorNote code={params.e} />
            <label htmlFor="complaints" className="h-panel">
              {t("complaint")}
            </label>
            <textarea id="complaints" name="complaints" rows={5} className="textarea" required />
            <span className="small muted">{t("complaintHint")}</span>
            <fieldset className="field" style={{ border: 0, margin: "8px 0 0", padding: 0 }}>
              <legend className="h-panel" style={{ marginBottom: 12 }}>
                {t("mechanic")}
              </legend>
              <div className="chips">
                {staff.map((m, i) => (
                  <label key={m.id} className="chip">
                    <input type="radio" name="mechanicId" value={m.id} defaultChecked={i === 0} />
                    <Icon name="check" size={16} stroke={2.4} />
                    {m.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <span className="small muted">{t("mechanicHint")}</span>
          </section>
          <section className="panel" style={{ gap: 12 }}>
            <span className="h-panel">{t("broughtBy")}</span>
            <div className="grid-2" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="signerName">{t("signerName")}</label>
                <input id="signerName" className="input" name="signerName" required />
              </div>
              <div className="field">
                <label htmlFor="signerPhone">{t("signerPhone")}</label>
                <input id="signerPhone" className="input" name="signerPhone" type="tel" required />
              </div>
            </div>
            <SignaturePad
              name="signature"
              label={tu("signature")}
              clearLabel={tu("clear")}
              invalid={params.e === "signatureMissing"}
            />
            <span className="spacer" />
            <button type="submit" className="btn primary lg block">
              <Icon name="check" stroke={2.4} />
              {t("saveOpen")}
            </button>
          </section>
        </form>
      </main>
    </>
  );
}
