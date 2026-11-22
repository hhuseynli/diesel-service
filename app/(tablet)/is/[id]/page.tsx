import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/app/_components/Icon";
import { PhotoInput } from "@/app/_components/PhotoInput";
import { SignaturePad } from "@/app/_components/SignaturePad";
import { requireSessionUser } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { qualityChecklist } from "@/lib/intake";
import { jobCard, mechanics, type JobCard } from "@/lib/intake/queries";
import type { JobStatus } from "@/lib/jobs/types";
import { Quantity } from "@/lib/money";
import {
  addFindingAction,
  addPartAction,
  addServiceAction,
  handOverAction,
  qualityCheckAction,
  removedPartAction,
  reprintStickerAction,
  sendToWarehouseAction,
  startWorkAction,
} from "../../actions";
import { ErrorNote } from "../../ErrorNote";
import { Plate } from "../../Plate";

// The job card (spec 01, 3.6-3.7): what was found and planned, and the one next step the
// formen can take in the job's current status.

/** Evidence for a finding: a camera photo or a short video (spec 01, 3.6; spec 00, 8). */
const EVIDENCE_TYPES = "image/jpeg,image/png,video/mp4";

const PROGRESS: JobStatus[] = [
  "QEBUL",
  "BAXIS",
  "QIYMETLENDIRME",
  "TESDIQ_GOZLEYIR",
  "TESDIQLENDI",
  "TEMIRDE",
  "HAZIR",
  "TEHVIL_VERILDI",
];

/** Where the job is on the progress bar; waiting for parts sits just before work. */
function progressIndex(status: JobStatus): number {
  if (status === "HISSE_GOZLEYIR") return PROGRESS.indexOf("TESDIQLENDI");
  if (status === "ODENILDI" || status === "BAGLANDI") return PROGRESS.length;
  return PROGRESS.indexOf(status);
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: IconName;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <h2 className="card-head">
        <Icon name={icon} />
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireSessionUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const query = await searchParams;
  const t = await getTranslations("job");
  const ti = await getTranslations("intake");
  const ts = await getTranslations("status");
  const tb = await getTranslations("board");
  const db = getDb();
  const job = await jobCard(db, id);
  if (!job) notFound();

  const inspecting = job.status === "QEBUL";
  const working = job.status === "TEMIRDE";
  const staff = inspecting || working ? await mechanics(db) : [];
  const checklist = working ? await qualityChecklist(db) : [];
  const jobField = <input type="hidden" name="jobId" value={job.id} />;
  const at = progressIndex(job.status);

  const nothing = <p className="muted">{t("nothingYet")}</p>;

  const findingForm = (
    <form action={addFindingAction}>
      {jobField}
      <label>
        {t("finding")}
        <textarea name="description" rows={2} required />
      </label>
      <div className="row">
        <label>
          {t("mechanic")}
          <select name="mechanicId" required>
            {staff.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="photo-grid">
        <PhotoInput
          name="files"
          label={t("findingPhotos")}
          hint={ti("takePhoto")}
          accept={EVIDENCE_TYPES}
          multiple
        />
      </div>
      <button type="submit">
        <Icon name="plus" size={18} />
        {t("addFinding")}
      </button>
    </form>
  );
  const serviceForm = (
    <form action={addServiceAction} className="add">
      {jobField}
      <div className="inline">
        <label>
          {t("service")}
          <input name="description" required />
        </label>
        <button type="submit">
          <Icon name="plus" size={18} />
          {t("addService")}
        </button>
      </div>
    </form>
  );
  const partForm = (
    <form action={addPartAction} className="add">
      {jobField}
      <label>
        {t("part")}
        <input name="description" required />
      </label>
      <div className="row">
        <label>
          {t("quantity")}
          <input name="quantity" inputMode="decimal" defaultValue="1" required />
        </label>
        <label>
          {t("unit")}
          <input name="unit" />
        </label>
        <button type="submit">
          <Icon name="plus" size={18} />
          {t("addPart")}
        </button>
      </div>
    </form>
  );

  return (
    <main>
      <Link href="/isler" className="back">
        <Icon name="back" size={18} />
        {t("back")}
      </Link>
      <ErrorNote code={query.e} />
      {query.yeni && (
        <p className="ok">
          <Icon name="check" />
          {ti("saved", { number: job.number })}
        </p>
      )}
      {query.od && <p role="alert">{t("odometerFlagged")}</p>}
      {query.st && (
        <Link className="btn primary large" href={`/stiker/${query.st}`}>
          <Icon name="printer" />
          {ti("printSticker")}
        </Link>
      )}

      <section className="card job-hero">
        <div className="job-hero-top">
          <h1>{t("title", { number: job.number })}</h1>
          <span className={`pill st-${job.status}`} data-testid="job-status">
            <span className="dot" aria-hidden="true" />
            {ts(job.status)}
          </span>
        </div>
        <div className="vehicle-line">
          <Icon name="truck" />
          <span>{job.vehicle || job.vin}</span>
          {job.plate && <Plate value={job.plate} />}
          <span className="mono vin6">{job.vin}</span>
        </div>
        <ol className="progress" aria-label={t("progress")}>
          {PROGRESS.map((s, i) => (
            <li key={s} className={i < at ? "done" : i === at ? "current" : undefined}>
              <span>{ts(s)}</span>
            </li>
          ))}
        </ol>
        <dl className="facts">
          <div>
            <dt>{t("client")}</dt>
            <dd>{job.client}</dd>
          </div>
          <div>
            <dt>{t("mechanic")}</dt>
            <dd>{job.mechanic ?? tb("noMechanic")}</dd>
          </div>
          <div className="wide">
            <dt>{t("complaints")}</dt>
            <dd>{job.complaints}</dd>
          </div>
        </dl>
      </section>

      <NextStep job={job} jobField={jobField} checklist={checklist} failed={query.qc === "0"} />

      <Section icon="clipboard" title={t("findings")} count={job.findings.length}>
        {job.findings.length === 0 ? (
          nothing
        ) : (
          <ul className="items">
            {job.findings.map((f) => (
              <li key={f.id}>
                <span>
                  {f.description}
                  {f.additional && <span className="tag">{t("duringWork")}</span>}
                </span>
                <span className="sub">{t("byMechanic", { name: f.mechanic })}</span>
                <span className="thumbs">
                  {f.attachmentIds.map((a) => (
                    // eslint-disable-next-line @next/next/no-img-element -- served by /fayl
                    <img key={a} src={`/fayl/${a}`} alt={t("findingPhotos")} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {inspecting && <div className="add">{findingForm}</div>}
      </Section>

      <Section icon="wrench" title={t("services")} count={job.services.length}>
        {job.services.length === 0 ? (
          nothing
        ) : (
          <ul className="items">
            {job.services.map((s) => (
              <li key={s.id}>{s.description}</li>
            ))}
          </ul>
        )}
        {inspecting && serviceForm}
      </Section>

      <Section icon="box" title={t("parts")} count={job.parts.length}>
        {job.parts.length === 0 ? (
          nothing
        ) : (
          <ul className="items">
            {job.parts.map((p) => (
              <li key={p.id}>
                {t("partLine", {
                  description: p.description,
                  quantity: Quantity.parse(p.quantity).formatAz(),
                  unit: p.unitHint ?? "",
                })}
              </li>
            ))}
          </ul>
        )}
        {inspecting && partForm}
      </Section>

      {working && (
        <section className="card">
          <details className="more">
            <summary>
              <Icon name="plus" size={18} />
              {t("additionalFinding")}
            </summary>
            <div className="options">
              {findingForm}
              {serviceForm}
              {partForm}
            </div>
          </details>
        </section>
      )}

      {(working || job.removedParts.length > 0) && (
        <Section icon="box" title={t("removedParts")} count={job.removedParts.length}>
          {job.removedParts.length > 0 && (
            <ul className="items">
              {job.removedParts.map((r) => (
                <li key={r.id}>
                  {t("removedLine", { description: r.description, disposition: t(r.disposition) })}
                </li>
              ))}
            </ul>
          )}
          {working && (
            <form action={removedPartAction} className="add">
              {jobField}
              <div className="row">
                <label>
                  {t("removedPart")}
                  <input name="description" required />
                </label>
                <label>
                  {t("disposition")}
                  <select name="disposition">
                    <option value="RETURNED_TO_CLIENT">{t("RETURNED_TO_CLIENT")}</option>
                    <option value="DISPOSED">{t("DISPOSED")}</option>
                    <option value="WARRANTY_CLAIM">{t("WARRANTY_CLAIM")}</option>
                  </select>
                </label>
              </div>
              <div className="photo-grid">
                <PhotoInput name="photo" label={ti("takePhoto")} hint={t("removedPart")} required />
              </div>
              <button type="submit">
                <Icon name="plus" size={18} />
                {t("addRemovedPart")}
              </button>
            </form>
          )}
        </Section>
      )}

      <details className="more no-print">
        <summary>
          <Icon name="printer" size={18} />
          {t("reprintSticker")}
        </summary>
        <form action={reprintStickerAction} className="card">
          {jobField}
          <input type="hidden" name="vehicleId" value={job.vehicleId} />
          <div className="inline">
            <label>
              {t("reprintReason")}
              <input name="reason" required />
            </label>
            <button type="submit">{t("reprintSticker")}</button>
          </div>
        </form>
      </details>
    </main>
  );
}

/** The one thing the formen does next in this status (azerbaijani-ui: one main action). */
async function NextStep({
  job,
  jobField,
  checklist,
  failed,
}: {
  job: JobCard;
  jobField: ReactNode;
  checklist: string[];
  failed: boolean;
}) {
  const t = await getTranslations("job");
  const ti = await getTranslations("intake");
  const waiting = (text: string) => (
    <section className="card">
      <p className="waiting">
        <Icon name="hourglass" size={28} />
        {text}
      </p>
    </section>
  );

  switch (job.status) {
    case "QEBUL":
      return (
        <section className="card next">
          <span className="eyebrow">{t("nextStep")}</span>
          <form action={sendToWarehouseAction}>
            {jobField}
            <button type="submit" className="primary large block">
              <Icon name="box" />
              {t("sendToWarehouse")}
            </button>
          </form>
        </section>
      );
    case "BAXIS":
      return waiting(t("waitingWarehouse"));
    case "QIYMETLENDIRME":
    case "TESDIQ_GOZLEYIR":
      return waiting(t("waitingClient"));
    case "TESDIQLENDI":
    case "HISSE_GOZLEYIR":
      return (
        <section className="card next">
          <span className="eyebrow">{t("nextStep")}</span>
          <form action={startWorkAction}>
            {jobField}
            <button type="submit" className="primary large block">
              <Icon name="wrench" />
              {t("startWork")}
            </button>
          </form>
        </section>
      );
    case "TEMIRDE":
      return (
        <section className="card next">
          <span className="eyebrow">{t("nextStep")}</span>
          <h2>{t("qualityCheck")}</h2>
          {failed && <p role="alert">{t("checkFailed")}</p>}
          <form action={qualityCheckAction}>
            {jobField}
            <div className="checks">
              {checklist.map((item) => (
                <label key={item} className="check">
                  <input type="checkbox" name="items" value={item} />
                  {t.has(`check.${item}`) ? t(`check.${item}`) : item}
                </label>
              ))}
            </div>
            <div className="photo-grid">
              <PhotoInput
                name="dashboard"
                label={t("dashboardPhoto")}
                hint={ti("takePhoto")}
                required
              />
            </div>
            <label>
              {t("notes")}
              <textarea name="notes" rows={2} />
            </label>
            <button type="submit" className="primary large block">
              <Icon name="check" />
              {t("submitCheck")}
            </button>
          </form>
        </section>
      );
    case "HAZIR":
    case "ODENILDI":
      return (
        <section className="card next">
          <span className="eyebrow">{t("nextStep")}</span>
          <h2>{t("handover")}</h2>
          <form action={handOverAction}>
            {jobField}
            <fieldset>
              <legend>{t("collector")}</legend>
              <div className="row">
                <label>
                  {ti("signerName")}
                  <input name="signerName" required />
                </label>
                <label>
                  {ti("signerPhone")}
                  <input name="signerPhone" type="tel" required />
                </label>
              </div>
              <SignaturePad name="signature" clearLabel={ti("clearSignature")} />
            </fieldset>
            <button type="submit" className="primary large block">
              <Icon name="pen" />
              {t("handOver")}
            </button>
          </form>
        </section>
      );
    case "TEHVIL_VERILDI":
      return waiting(t("waitingPayment"));
    default:
      return null;
  }
}
