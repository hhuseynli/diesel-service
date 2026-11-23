import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { Plate } from "@/app/_ui/Plate";
import { StatusBadge } from "@/app/_ui/StatusBadge";
import { TabletBar } from "@/app/_ui/TabletBar";
import { requireSessionUser, withSessionActor } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/db/uuid";
import { durationParts, formatDateTime, formatDayTime } from "@/lib/format";
import { jobCard, mechanics, type JobCard } from "@/lib/intake/queries";
import type { JobStatus } from "@/lib/jobs/types";
import { groupThousands, Quantity } from "@/lib/money";
import { can } from "@/lib/permissions";
import {
  assignMechanicAction,
  cancelJobAction,
  sendToWarehouseAction,
  startWorkAction,
} from "../../actions";

// 3.4-7.1 İş kartı (spec 01, 3.6-3.7): what was found, planned and done on the left; on
// the right the one next step for the job's status, the job's details, and the rare
// actions (reprint, cancel). Each step that records something has its own screen.

/** Where each status sits on the 7-step bar: Qəbul, Baxış, Təsdiq, Təmir, Hazır, Təhvil, Bağlandı. */
const PROGRESS: Record<JobStatus, number> = {
  QEBUL: 0,
  BAXIS: 1,
  QIYMETLENDIRME: 1,
  TESDIQ_GOZLEYIR: 2,
  TESDIQLENDI: 3,
  HISSE_GOZLEYIR: 3,
  TEMIRDE: 3,
  HAZIR: 4,
  TEHVIL_VERILDI: 5,
  ODENILDI: 5,
  BAGLANDI: 6,
  LEGV: 1,
};

/** Findings, services and parts are added until the work is done (0028). */
const OPEN: JobStatus[] = [
  "QEBUL",
  "BAXIS",
  "QIYMETLENDIRME",
  "TESDIQ_GOZLEYIR",
  "TESDIQLENDI",
  "HISSE_GOZLEYIR",
  "TEMIRDE",
];

const PART_PILL: Record<string, string> = {
  NEW: "pill",
  MATCHED: "pill office",
  CANCELLED: "pill",
};

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireSessionUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const db = getDb();
  const job = await jobCard(db, id);
  if (!job) notFound();
  const t = await getTranslations("job");
  const tu = await getTranslations("ui");
  const ts = await getTranslations("status");
  const tb = await getTranslations("board");

  const at = PROGRESS[job.status];
  const open = OPEN.includes(job.status);
  const findingsShown = job.findings.length > 0 || job.status !== "QEBUL";
  const staff = query.mech === "1" && open ? await mechanics(db) : [];
  const since = durationParts(job.minutesInStatus);

  return (
    <>
      <TabletBar back={{ href: "/isler", label: tu("board") }} title={t("cardTitle")} />
      <div className="job-head">
        <div className="job-head-row">
          <span className="job-number">{job.number}</span>
          <StatusBadge status={job.status} size="lg" testId="job-status" />
          <span className="since">
            <Icon name="clock" size={15} />
            {t("inStatus", { time: tu(`duration.${since.key}`, since.values) })}
          </span>
          {job.status === "BAGLANDI" && (
            <span className="locked">
              <Icon name="lock" size={14} />
              {t("lockedNote")}
            </span>
          )}
          <span className="spacer" />
          <span className="job-vehicle">
            <strong>{job.vehicle || job.vin}</strong>
            <Plate plate={job.plate} vin={job.vin} />
          </span>
        </div>
        <ol
          className={job.status === "LEGV" ? "progress cancelled" : "progress"}
          aria-label={t("progress.label")}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <li
              key={i}
              className={i < at ? "done" : i === at ? "current" : undefined}
              aria-current={i === at ? "step" : undefined}
            >
              {t(`progress.p${i}`)}
            </li>
          ))}
        </ol>
      </div>

      <main className="main job">
        <div className="col">
          <ErrorNote code={query.e} />
          {query.yeni && (
            <Notice kind="success" title={t("opened", { number: job.number })}>
              {t("openedBody")}
            </Notice>
          )}
          {query.od && <Notice kind="warn" role="alert" title={t("odometerFlagged")} />}
          {query.qc === "0" && <Notice kind="error" role="alert" title={t("checkFailed")} />}
          {query.st && (
            <Link className="btn primary lg block" href={`/stiker/${query.st}?back=/is/${job.id}`}>
              <Icon name="printer" />
              {t("printSticker")}
            </Link>
          )}

          {!findingsShown ? (
            <>
              <section className="empty-card">
                <h2 className="h-panel">{t("noFindingsTitle")}</h2>
                <p className="muted">{t("noFindingsBody")}</p>
              </section>
              <section className="panel tight">
                <h2 className="h-panel">{t("complaint")}</h2>
                <p>{job.complaints}</p>
              </section>
            </>
          ) : (
            <>
              <section className="panel tight">
                <span className="panel-head">
                  <h2 className="h-panel">{t("findings")}</h2>
                  <span className="small muted">
                    {t("findingsCount", { n: job.findings.length })}
                  </span>
                </span>
                <ul className="rows">
                  {job.findings.map((f) => (
                    <li key={f.id} className="finding">
                      <span className="thumbs">
                        {f.attachments.map((a) => (
                          <span key={a.id} className="thumb">
                            {a.video ? (
                              <Icon name="video" size={22} />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element -- served by /fayl
                              <img src={`/fayl/${a.id}`} alt={t("media")} />
                            )}
                          </span>
                        ))}
                      </span>
                      <span className="finding-text">
                        <span className="finding-title">
                          {f.description}
                          {f.additional && <span className="pill amber">{t("duringWork")}</span>}
                        </span>
                        <span className="tiny muted">
                          {t("findingWho", {
                            mechanic: f.mechanic,
                            by: f.recordedBy,
                            at: formatDayTime(f.at),
                          })}
                        </span>
                        {f.correctionReason && (
                          <span className="tiny muted">
                            {t("correction", { reason: f.correctionReason })}
                          </span>
                        )}
                        {open && job.status !== "QEBUL" && !f.correctsId && (
                          <Link className="tiny" href={`/is/${job.id}/tapinti?duzelt=${f.id}`}>
                            {t("findingFix")}
                          </Link>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="panel tight">
                <h2 className="h-panel">{t("worksParts")}</h2>
                {job.services.length > 0 && (
                  <span className="small muted">
                    {t("worksLine", { list: job.services.map((s) => s.description).join(" · ") })}
                  </span>
                )}
                {job.services.length === 0 && job.parts.length === 0 && (
                  <span className="small muted">{t("noWorks")}</span>
                )}
                <ul className="rows">
                  {job.parts.map((p) => (
                    <li key={p.id} className="line">
                      <span>{p.description}</span>
                      <span className="muted num">
                        {t("partQty", {
                          q: Quantity.parse(p.quantity).formatAz(),
                          unit: p.unitHint ?? "",
                        })}
                      </span>
                      {p.additional && <span className="pill amber">{t("additionalTag")}</span>}
                      <span className={PART_PILL[p.status] ?? "pill"}>
                        {t(`partState.${p.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {job.removedParts.length > 0 && (
            <section className="panel tight">
              <h2 className="h-panel">{t("removedParts")}</h2>
              <ul className="rows">
                {job.removedParts.map((r) => (
                  <li key={r.id} className="line">
                    <span className="finding-text">
                      <span className="finding-title">{r.description}</span>
                      <span className="tiny muted">
                        {t("removedWho", { mechanic: r.mechanic ?? "", at: formatDayTime(r.at) })}
                      </span>
                    </span>
                    <span className="pill">{t(`disp.${r.disposition}`)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {job.qualityCheck && (
            <section className="panel tight">
              <span className="panel-head">
                <h2 className="h-panel">{t("qcTitle")}</h2>
                <span className="pill green">{t("qcPassed")}</span>
              </span>
              <span className="small muted">
                {t("qcLine", {
                  mechanic: job.qualityCheck.mechanic ?? "",
                  by: job.qualityCheck.checkedBy,
                  at: formatDateTime(job.qualityCheck.at),
                })}
              </span>
            </section>
          )}

          {job.handover && (
            <section className="panel tight">
              <h2 className="h-panel">{t("handoverTitle")}</h2>
              <span className="small muted">
                {t("handoverLine", {
                  number: job.handover.number,
                  name: job.handover.signerName,
                  phone: job.handover.signerPhone,
                  at: formatDateTime(job.handover.at),
                })}
              </span>
            </section>
          )}
        </div>

        <div className="col">
          <NextStep job={job} />
          <Actions job={job} />
          <dl className="kv">
            <div>
              <dt>{t("info.client")}</dt>
              <dd>{job.client}</dd>
            </div>
            {job.contractNumber && (
              <div>
                <dt>{t("info.contract")}</dt>
                <dd className="mono">{job.contractNumber}</dd>
              </div>
            )}
            {job.driver && (
              <div>
                <dt>{t("info.driver")}</dt>
                <dd>{job.driver}</dd>
              </div>
            )}
            <div>
              <dt>{t("info.mechanic")}</dt>
              <dd>{job.mechanic ?? tb("noMechanic")}</dd>
            </div>
            {job.intakeKm !== null && (
              <div>
                <dt>{t("info.intakeKm")}</dt>
                <dd className="num">{tu("km", { km: groupThousands(job.intakeKm) })}</dd>
              </div>
            )}
            <div>
              <dt>{t("info.receivedBy")}</dt>
              <dd>
                {t("receivedLine", { name: job.receivedBy, at: formatDayTime(job.receivedAt) })}
              </dd>
            </div>
          </dl>
          {open && query.mech !== "1" && (
            <Link className="btn block" href={`/is/${job.id}?mech=1`}>
              <Icon name="wrench" />
              {t("assignMechanic")}
            </Link>
          )}
          {staff.length > 0 && (
            <form action={assignMechanicAction} className="panel tight">
              <input type="hidden" name="jobId" value={job.id} />
              <span className="label">{t("info.mechanic")}</span>
              <div className="chips">
                {staff.map((m) => (
                  <label key={m.id} className="chip sm">
                    <input
                      type="radio"
                      name="mechanicId"
                      value={m.id}
                      defaultChecked={m.id === job.mechanicId}
                      required
                    />
                    <Icon name="check" size={16} stroke={2.4} />
                    {m.name}
                  </label>
                ))}
              </div>
              <button type="submit" className="btn outline">
                {t("assign")}
              </button>
            </form>
          )}
          {job.status !== "BAGLANDI" && job.status !== "LEGV" && (
            <>
              <Link
                className="btn block"
                href={`/stiker/yeni?v=${job.vehicleId}&back=${encodeURIComponent(`/is/${job.id}`)}`}
              >
                <Icon name="printer" />
                {t("reprint")}
              </Link>
              {!["TEHVIL_VERILDI", "ODENILDI"].includes(job.status) && (
                <Link className="btn danger-text block" href={`/is/${job.id}?legv=1`}>
                  {t("cancelJob")}
                </Link>
              )}
            </>
          )}
        </div>
      </main>

      {query.legv === "1" && (
        <CancelDialog job={job} error={query.e} statusLabel={ts(job.status)} />
      )}
    </>
  );
}

function Panel({
  kind,
  label,
  text,
  sub,
  children,
}: {
  kind: "do" | "wait" | "cancel";
  label: string;
  text: string;
  sub: string;
  children?: ReactNode;
}) {
  return (
    <section className={kind === "do" ? "next" : `next ${kind}`} data-testid="next-step">
      <span className="next-label">{label}</span>
      <span className="next-text">
        {kind !== "do" && <Icon name="hourglass" size={22} />}
        {text}
      </span>
      <span className="small muted">{sub}</span>
      {children}
    </section>
  );
}

/** The one thing the formen does next in this status (design: Növbəti addım). */
async function NextStep({ job }: { job: JobCard }) {
  const t = await getTranslations("job");
  const label = t("nextStep");
  const go = (href: string, text: string) => (
    <Link className="btn primary lg block" href={href}>
      {text}
      <Icon name="arrow" />
    </Link>
  );
  const act = (action: (form: FormData) => Promise<void>, text: string, primary = true) => (
    <form action={action}>
      <input type="hidden" name="jobId" value={job.id} />
      <button type="submit" className={primary ? "btn primary lg block" : "btn outline lg block"}>
        {text}
        <Icon name="arrow" />
      </button>
    </form>
  );
  const wait = (text: string, sub = t("next.nothingForYou")) => (
    <Panel kind="wait" label={label} text={text} sub={sub} />
  );

  switch (job.status) {
    case "QEBUL":
      return job.findings.length === 0 ? (
        <Panel
          kind="do"
          label={label}
          text={t("next.startInspection")}
          sub={
            job.mechanic
              ? t("next.startInspectionSub", { mechanic: job.mechanic })
              : t("next.startInspectionNoMech")
          }
        >
          {go(`/is/${job.id}/tapinti`, t("addFinding"))}
        </Panel>
      ) : (
        <Panel
          kind="do"
          label={label}
          text={t("next.inspectionReady")}
          sub={t("next.inspectionReadySub", {
            f: job.findings.length,
            w: job.services.length,
            p: job.parts.length,
          })}
        >
          {act(sendToWarehouseAction, t("sendToWarehouse"))}
        </Panel>
      );
    case "BAXIS":
      return wait(t("next.waitWarehouse"));
    case "QIYMETLENDIRME":
      return wait(t("next.waitEstimate"));
    case "TESDIQ_GOZLEYIR":
      return wait(t("next.waitClient"));
    case "TESDIQLENDI":
      return (
        <Panel kind="do" label={label} text={t("next.approved")} sub={t("next.approvedSub")}>
          {act(startWorkAction, t("startWork"))}
        </Panel>
      );
    case "HISSE_GOZLEYIR":
      return (
        <Panel kind="wait" label={label} text={t("next.waitParts")} sub={t("next.waitPartsSub")}>
          {act(startWorkAction, t("startWork"), false)}
        </Panel>
      );
    case "TEMIRDE":
      return (
        <Panel kind="do" label={label} text={t("next.inWork")} sub={t("next.inWorkSub")}>
          {go(`/is/${job.id}/yoxlama`, t("qualityCheck"))}
        </Panel>
      );
    case "HAZIR":
      return (
        <Panel kind="do" label={label} text={t("next.ready")} sub={t("next.readySub")}>
          {go(`/is/${job.id}/tehvil`, t("handOver"))}
        </Panel>
      );
    case "TEHVIL_VERILDI":
      return wait(t("next.handedOver"), t("next.handedOverSub"));
    case "ODENILDI":
      return (
        <Panel kind="do" label={label} text={t("next.paid")} sub={t("next.paidSub")}>
          {go(`/is/${job.id}/tehvil`, t("handOver"))}
        </Panel>
      );
    case "BAGLANDI":
      return wait(t("next.closed"), t("next.closedSub"));
    case "LEGV":
      return (
        <Panel
          kind="cancel"
          label={t("cancelledLabel")}
          text={t("next.cancelled")}
          sub={t("next.cancelledSub", {
            reason: job.cancel?.reason ?? "",
            by: job.cancel?.by ?? "",
            at: job.cancel?.at ? formatDateTime(job.cancel.at) : "",
          })}
        />
      );
  }
}

/** Secondary actions under the next step, by status (design: İş kartı komponenti). */
async function Actions({ job }: { job: JobCard }) {
  const t = await getTranslations("job");
  const links: { href: string; label: string }[] = [];
  if (job.status === "QEBUL" && job.findings.length > 0) {
    links.push({ href: `/is/${job.id}/tapinti`, label: t("addFinding") });
  }
  if (
    ["BAXIS", "QIYMETLENDIRME", "TESDIQ_GOZLEYIR", "TESDIQLENDI", "HISSE_GOZLEYIR"].includes(
      job.status,
    )
  ) {
    links.push({ href: `/is/${job.id}/tapinti`, label: t("addOrFix") });
  }
  if (job.status === "TEMIRDE") {
    links.push({ href: `/is/${job.id}/kohne`, label: t("removedPart") });
    links.push({ href: `/is/${job.id}/tapinti`, label: t("extraFinding") });
  }
  return (
    <>
      {links.map((l) => (
        <Link key={l.label} className="btn outline block" href={l.href}>
          {l.label}
        </Link>
      ))}
    </>
  );
}

/** 6.3 Ləğv et: a reason is required; without permission, say who can (spec 01, 6). */
async function CancelDialog({
  job,
  error,
  statusLabel,
}: {
  job: JobCard;
  error?: string;
  statusLabel: string;
}) {
  const t = await getTranslations("job");
  const tu = await getTranslations("ui");
  const allowed = await withSessionActor((tx) =>
    can(tx, job.status === "QEBUL" ? "CANCEL_JOB_AT_INTAKE" : "CANCEL_JOB"),
  );
  return (
    <div className="overlay">
      {allowed ? (
        <form
          action={cancelJobAction}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
          className="dialog"
        >
          <input type="hidden" name="jobId" value={job.id} />
          <h2 id="cancel-title">{t("cancelTitle")}</h2>
          <span className="muted meta">
            <span className="mono">{job.number}</span>
            <span>
              {t("cancelSubtitle", {
                vehicle: job.vehicle || job.vin,
                client: job.client,
                status: statusLabel,
              })}
            </span>
          </span>
          <ErrorNote code={error} />
          <span className="label">{t("cancelReason")}</span>
          <div className="chips">
            {(["refused", "wrongCar", "other"] as const).map((k, i) => (
              <label key={k} className="chip">
                <input type="radio" name="reasonKind" value={k} defaultChecked={i === 0} />
                <Icon name="check" size={16} stroke={2.4} />
                {t(`reasons.${k}`)}
              </label>
            ))}
          </div>
          <textarea name="details" rows={2} className="textarea" aria-label={t("cancelDetails")} />
          <span className="small muted">{t("cancelNote")}</span>
          <div className="btn-row">
            <Link className="btn outline lg" href={`/is/${job.id}`}>
              {tu("back")}
            </Link>
            <button type="submit" className="btn danger lg">
              {t("cancelConfirm")}
            </button>
          </div>
        </form>
      ) : (
        <div role="alertdialog" aria-modal="true" aria-labelledby="denied-title" className="dialog">
          <span className="round-icon sm">
            <Icon name="lock" size={28} />
          </span>
          <h2 id="denied-title">{t("deniedTitle")}</h2>
          <p className="muted">{t("deniedBody")}</p>
          <Link className="btn primary lg block" href={`/is/${job.id}`}>
            {t("close")}
          </Link>
        </div>
      )}
    </div>
  );
}
