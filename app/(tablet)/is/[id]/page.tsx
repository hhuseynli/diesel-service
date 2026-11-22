import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { SignaturePad } from "@/app/_components/SignaturePad";
import { getDb } from "@/lib/db/client";
import { ALLOWED_TYPES } from "@/lib/files";
import { qualityChecklist } from "@/lib/intake";
import { jobCard, mechanics } from "@/lib/intake/queries";
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

// The job card (spec 01, 3.6-3.7): what was found and planned, and the one next step the
// formen can take in the job's current status.

const FILE_TYPES = Object.keys(ALLOWED_TYPES).join(",");

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
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
  const additional = working ? "1" : "0";
  const jobField = <input type="hidden" name="jobId" value={job.id} />;

  return (
    <main>
      <h1>{t("title", { number: job.number })}</h1>
      <ErrorNote code={query.e} />
      {query.yeni && <p className="ok">{ti("saved", { number: job.number })}</p>}
      {query.od && <p role="alert">{t("odometerFlagged")}</p>}
      {query.st && (
        <Link className="primary" href={`/stiker/${query.st}`}>
          {ti("printSticker")}
        </Link>
      )}

      <dl className="facts">
        <dt>{t("status")}</dt>
        <dd data-testid="job-status">{ts(job.status)}</dd>
        <dt>{t("vehicle")}</dt>
        <dd>{[job.vehicle, job.plate, job.vin].filter(Boolean).join(" · ")}</dd>
        <dt>{t("client")}</dt>
        <dd>{job.client}</dd>
        <dt>{t("mechanic")}</dt>
        <dd>{job.mechanic ?? tb("noMechanic")}</dd>
        <dt>{t("complaints")}</dt>
        <dd>{job.complaints}</dd>
      </dl>

      <section>
        <h2>{t("findings")}</h2>
        <ul>
          {job.findings.map((f) => (
            <li key={f.id}>
              {f.additional ? t("additionalLine", { description: f.description }) : f.description}
              <span className="muted">{t("byMechanic", { name: f.mechanic })}</span>
              <span className="thumbs">
                {f.attachmentIds.map((a) => (
                  // eslint-disable-next-line @next/next/no-img-element -- served by /fayl, not optimised
                  <img key={a} src={`/fayl/${a}`} alt={t("findingPhotos")} />
                ))}
              </span>
            </li>
          ))}
        </ul>
        <h2>{t("services")}</h2>
        <ul>
          {job.services.map((s) => (
            <li key={s.id}>{s.description}</li>
          ))}
        </ul>
        <h2>{t("parts")}</h2>
        <ul>
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
        {job.removedParts.length > 0 && (
          <>
            <h2>{t("removedParts")}</h2>
            <ul>
              {job.removedParts.map((r) => (
                <li key={r.id}>
                  {t("removedLine", { description: r.description, disposition: t(r.disposition) })}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {(inspecting || working) && (
        <section className="forms">
          <h2>{working ? t("additionalFinding") : t("inspection")}</h2>
          <form action={addFindingAction}>
            {jobField}
            <input type="hidden" name="additional" value={additional} />
            <label>
              {t("finding")}
              <textarea name="description" rows={2} required />
            </label>
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
            <label>
              {t("findingPhotos")}
              <input type="file" name="files" accept={FILE_TYPES} capture="environment" multiple />
            </label>
            <button type="submit">{t("addFinding")}</button>
          </form>
          <form action={addServiceAction}>
            {jobField}
            <input type="hidden" name="additional" value={additional} />
            <label>
              {t("service")}
              <input name="description" required />
            </label>
            <button type="submit">{t("addService")}</button>
          </form>
          <form action={addPartAction}>
            {jobField}
            <input type="hidden" name="additional" value={additional} />
            <label>
              {t("part")}
              <input name="description" required />
            </label>
            <label>
              {t("quantity")}
              <input name="quantity" inputMode="decimal" defaultValue="1" required />
            </label>
            <label>
              {t("unit")}
              <input name="unit" />
            </label>
            <button type="submit">{t("addPart")}</button>
          </form>
        </section>
      )}

      {inspecting && (
        <form action={sendToWarehouseAction}>
          {jobField}
          <button type="submit" className="primary">
            {t("sendToWarehouse")}
          </button>
        </form>
      )}

      {job.status === "BAXIS" && <p className="muted">{t("waitingWarehouse")}</p>}
      {(job.status === "QIYMETLENDIRME" || job.status === "TESDIQ_GOZLEYIR") && (
        <p className="muted">{t("waitingClient")}</p>
      )}

      {(job.status === "TESDIQLENDI" || job.status === "HISSE_GOZLEYIR") && (
        <form action={startWorkAction}>
          {jobField}
          <button type="submit" className="primary">
            {t("startWork")}
          </button>
        </form>
      )}

      {working && (
        <>
          <section className="forms">
            <h2>{t("removedPart")}</h2>
            <form action={removedPartAction}>
              {jobField}
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
              <label>
                {ti("takePhoto")}
                <input
                  type="file"
                  name="photo"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  required
                />
              </label>
              <button type="submit">{t("addRemovedPart")}</button>
            </form>
          </section>
          <section className="forms">
            <h2>{t("qualityCheck")}</h2>
            {query.qc === "0" && <p role="alert">{t("checkFailed")}</p>}
            <form action={qualityCheckAction}>
              {jobField}
              {checklist.map((item) => (
                <label key={item} className="check">
                  <input type="checkbox" name="items" value={item} />
                  {t.has(`check.${item}`) ? t(`check.${item}`) : item}
                </label>
              ))}
              <label>
                {t("dashboardPhoto")}
                <input
                  type="file"
                  name="dashboard"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  required
                />
              </label>
              <label>
                {t("notes")}
                <textarea name="notes" rows={2} />
              </label>
              <button type="submit" className="primary">
                {t("submitCheck")}
              </button>
            </form>
          </section>
        </>
      )}

      {(job.status === "HAZIR" || job.status === "ODENILDI") && (
        <section className="forms">
          <h2>{t("handover")}</h2>
          <form action={handOverAction}>
            {jobField}
            <fieldset>
              <legend>{t("collector")}</legend>
              <label>
                {ti("signerName")}
                <input name="signerName" required />
              </label>
              <label>
                {ti("signerPhone")}
                <input name="signerPhone" type="tel" required />
              </label>
              <SignaturePad name="signature" clearLabel={ti("clearSignature")} />
            </fieldset>
            <button type="submit" className="primary">
              {t("handOver")}
            </button>
          </form>
        </section>
      )}

      {job.status === "TEHVIL_VERILDI" && <p className="muted">{t("waitingPayment")}</p>}

      <details className="no-print">
        <summary>{t("reprintSticker")}</summary>
        <form action={reprintStickerAction}>
          {jobField}
          <input type="hidden" name="vehicleId" value={job.vehicleId} />
          <label>
            {t("reprintReason")}
            <input name="reason" required />
          </label>
          <button type="submit">{t("reprintSticker")}</button>
        </form>
      </details>
    </main>
  );
}
