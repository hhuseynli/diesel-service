import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Plate } from "@/app/_ui/Plate";
import { SignaturePad } from "@/app/_ui/SignaturePad";
import { TabletBar } from "@/app/_ui/TabletBar";
import { groupThousands } from "@/lib/money";
import { handOverAction } from "../../../actions";
import { loadJob } from "../load";

// 6.1 Təhvil-Təslim (spec 01, 3.7; plan 04, B11): what was done and what happens to the old
// parts, then the person collecting the car signs. The act is numbered on "Təhvil ver".

export default async function HandoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { job } = await loadJob(params);
  const query = await searchParams;
  const t = await getTranslations("job");
  const tu = await getTranslations("ui");
  const ti = await getTranslations("intake");

  return (
    <>
      <TabletBar back={{ href: `/is/${job.id}`, label: job.number }} title={t("handoverScreen")} />
      <form action={handOverAction} className="main" style={{ ["--side" as string]: "460px" }}>
        <input type="hidden" name="jobId" value={job.id} />
        <section className="panel scroll" style={{ gap: 12 }}>
          <span className="who">
            <span className="h-card">{t("act")}</span>
            <span className="muted">{t("actNote")}</span>
          </span>
          <span className="job-vehicle divider">
            <strong>{job.vehicle || job.vin}</strong>
            <Plate plate={job.plate} vin={job.vin} />
          </span>
          <span className="small muted mono">
            {t("vinClient", { vin: job.vin, client: job.client })}
          </span>
          {job.intakeKm !== null && (
            <div className="field">
              <span className="label">{t("info.intakeKm")}</span>
              <span className="num">{tu("km", { km: groupThousands(job.intakeKm) })}</span>
            </div>
          )}
          <span className="label divider">{t("works")}</span>
          <span>{job.services.map((s) => s.description).join(" · ") || t("noWorks")}</span>
          {job.removedParts.length > 0 && (
            <>
              <span className="label divider">{t("removedParts")}</span>
              <span>
                {job.removedParts
                  .map((r) =>
                    t("removedLine", { part: r.description, disp: t(`disp.${r.disposition}`) }),
                  )
                  .join(" · ")}
              </span>
            </>
          )}
          <span className="divider" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="hourglass" size={18} />
            {job.status === "ODENILDI" ? t("paymentDone") : t("paymentWaiting")}
          </span>
        </section>
        <section className="panel" style={{ gap: 12 }}>
          <ErrorNote code={query.e} />
          <span className="h-panel">{t("collector")}</span>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="signerName">{ti("signerName")}</label>
              <input id="signerName" className="input" name="signerName" required />
            </div>
            <div className="field">
              <label htmlFor="signerPhone">{ti("signerPhone")}</label>
              <input id="signerPhone" className="input" name="signerPhone" type="tel" required />
            </div>
          </div>
          <SignaturePad
            name="signature"
            label={tu("signature")}
            clearLabel={tu("clear")}
            invalid={query.e === "signatureMissing"}
          />
          <span className="tiny muted">{t("orderNote")}</span>
          <span className="spacer" />
          <button type="submit" className="btn primary lg block">
            <Icon name="check" stroke={2.4} />
            {t("handOver")}
          </button>
        </section>
      </form>
    </>
  );
}
