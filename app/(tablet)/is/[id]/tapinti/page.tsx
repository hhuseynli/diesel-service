import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { MechanicChips } from "@/app/_ui/MechanicChips";
import { Notice } from "@/app/_ui/Notice";
import { PhotoTile } from "@/app/_ui/PhotoTile";
import { TabletBar } from "@/app/_ui/TabletBar";
import { saveFindingAction } from "../../../actions";
import { loadJob } from "../load";
import { PartsRows } from "./PartsRows";

// 4.1 Tapıntı əlavə et (spec 01, 3.6): a finding with its mechanic and evidence, the work
// planned for it and the parts it needs. During work it becomes an Əlavə akt request; after
// "Anbara göndər" a finding is corrected with a reason (?duzelt=<finding>).

/** Evidence for a finding: a camera photo or a short video (spec 00, section 8). */
const EVIDENCE = "image/jpeg,image/png,video/mp4";
const ESTIMATE_SENT = ["TESDIQ_GOZLEYIR", "TESDIQLENDI", "HISSE_GOZLEYIR", "TEMIRDE"];

export default async function FindingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { job, staff } = await loadJob(params);
  const query = await searchParams;
  const t = await getTranslations("job");
  const tu = await getTranslations("ui");
  const fixing = query.duzelt ? job.findings.find((f) => f.id === query.duzelt) : undefined;
  if (query.duzelt && !fixing) notFound();
  const during = ESTIMATE_SENT.includes(job.status);
  const title = fixing ? t("findingFix") : during ? t("findingDuring") : t("findingAdd");

  return (
    <>
      <TabletBar back={{ href: `/is/${job.id}`, label: job.number }} title={title} />
      <main className="frame">
        <form action={saveFindingAction} className="main">
          <input type="hidden" name="jobId" value={job.id} />
          {fixing && <input type="hidden" name="findingId" value={fixing.id} />}
          <section className="panel scroll">
            <ErrorNote code={query.e} />
            <span className="h-panel">{t("info.mechanic")}</span>
            <MechanicChips staff={staff} selected={job.mechanicId} />
            <label htmlFor="what" className="h-panel">
              {t("what")}
            </label>
            <textarea
              id="what"
              name="description"
              rows={2}
              className="textarea"
              defaultValue={fixing?.description}
              required={Boolean(fixing)}
            />
            <span className="h-panel">
              {t("media")} <span className="muted light">{t("mediaMin")}</span>
            </span>
            <div className="tiles row">
              <PhotoTile
                name="files"
                label={t("mediaTile")}
                hint={tu("tapToShoot")}
                accept={EVIDENCE}
                multiple
                width={200}
                height={150}
              />
            </div>
          </section>
          <section className="panel scroll" style={{ gap: 12 }}>
            {during && !fixing && (
              <Notice kind="warn" title={t("duringTitle")}>
                {t("duringBody")}
              </Notice>
            )}
            {fixing && (
              <>
                <Notice title={t("fixTitle")}>{t("fixBody")}</Notice>
                <div className="field">
                  <label htmlFor="reason">{t("fixReason")}</label>
                  <textarea id="reason" name="reason" rows={2} className="textarea" required />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="service">{t("service")}</label>
              <input id="service" className="input" name="service" />
            </div>
            <span className="label">
              {t("partsTitle")} <span className="muted light">{t("partsHint")}</span>
            </span>
            <PartsRows />
            <span className="spacer" />
            <button type="submit" className="btn primary lg block">
              <Icon name="check" stroke={2.4} />
              {tu("save")}
            </button>
          </section>
        </form>
      </main>
    </>
  );
}
