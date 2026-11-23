import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { MechanicChips } from "@/app/_ui/MechanicChips";
import { PhotoTile } from "@/app/_ui/PhotoTile";
import { TabletBar } from "@/app/_ui/TabletBar";
import { removedPartAction } from "../../../actions";
import { loadJob } from "../load";

// 5.2 Köhnə hissə (spec 01, 3.7; R7): which part was replaced, by whom, its photo, and what
// happens to it. The parts requested for the job are offered first.

const DISPOSITIONS = ["RETURNED_TO_CLIENT", "DISPOSED", "WARRANTY_CLAIM"] as const;

export default async function RemovedPartPage({
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
  const parts = [
    ...new Set(job.parts.filter((p) => p.status !== "CANCELLED").map((p) => p.description)),
  ];

  return (
    <>
      <TabletBar back={{ href: `/is/${job.id}`, label: job.number }} title={t("removedTitle")} />
      <main className="frame">
        <form action={removedPartAction} className="main" style={{ ["--side" as string]: "440px" }}>
          <input type="hidden" name="jobId" value={job.id} />
          <section className="panel scroll">
            <ErrorNote code={query.e} />
            <span className="h-panel">{t("which")}</span>
            <div className="chips">
              {parts.map((p, i) => (
                <label key={p} className="chip">
                  <input type="radio" name="part" value={p} defaultChecked={i === 0} required />
                  <Icon name="check" size={16} stroke={2.4} />
                  {p}
                </label>
              ))}
              <label className="chip">
                <input
                  type="radio"
                  name="part"
                  value="other"
                  defaultChecked={parts.length === 0}
                  required
                />
                <Icon name="check" size={16} stroke={2.4} />
                {t("otherPart")}
              </label>
            </div>
            <input
              className="input"
              name="otherPart"
              aria-label={t("otherPartName")}
              placeholder={t("otherPartName")}
            />
            <span className="h-panel">{t("info.mechanic")}</span>
            <MechanicChips staff={staff} selected={job.mechanicId} />
            <span className="h-panel">{t("removedPhoto")}</span>
            <div className="tiles row">
              <PhotoTile
                name="photo"
                label={t("removedPhoto")}
                hint={tu("tapToShoot")}
                required
                width={280}
                height={190}
              />
            </div>
          </section>
          <section className="panel">
            <span className="h-panel">{t("fate")}</span>
            {DISPOSITIONS.map((d, i) => (
              <label key={d} className="option">
                <input type="radio" name="disposition" value={d} defaultChecked={i === 0} />
                <span className="option-dot" aria-hidden="true">
                  <Icon name="check" size={16} stroke={2.4} />
                </span>
                <span className="option-text">
                  <strong>{t(`disp.${d}`)}</strong>
                  <small>{t(`dispHint.${d}`)}</small>
                </span>
              </label>
            ))}
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
