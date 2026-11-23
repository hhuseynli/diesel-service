import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { MechanicChips } from "@/app/_ui/MechanicChips";
import { PhotoTile } from "@/app/_ui/PhotoTile";
import { TabletBar } from "@/app/_ui/TabletBar";
import { getDb } from "@/lib/db/client";
import { qualityChecklist } from "@/lib/intake";
import { loadJob } from "../load";
import { QcForm } from "./QcForm";

// 5.3 Keyfiyyət yoxlaması (spec 01, 3.7; plan 04, B10): the checklist from the
// `quality_checklist` setting, the mechanic and the dashboard photo.

export default async function QualityCheckPage({
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
  const checklist = await qualityChecklist(getDb());

  return (
    <>
      <TabletBar back={{ href: `/is/${job.id}`, label: job.number }} title={t("qcTitle")} />
      <QcForm
        jobId={job.id}
        items={checklist.map((key) => ({
          key,
          label: t.has(`check.${key}`) ? t(`check.${key}`) : key,
        }))}
        left={
          <>
            <span className="h-panel" style={{ marginTop: 4 }}>
              {t("info.mechanic")}
            </span>
            <MechanicChips staff={staff} selected={job.mechanicId} />
          </>
        }
        right={
          <>
            <ErrorNote code={query.e} />
            <span className="h-panel">{t("dashboardPhoto")}</span>
            <div className="tiles row">
              <PhotoTile
                name="dashboard"
                label={t("dashboardPhoto")}
                hint={tu("tapToShoot")}
                required
                width={390}
                height={200}
              />
            </div>
          </>
        }
      />
    </>
  );
}
