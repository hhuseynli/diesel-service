"use server";

import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { redirect, unstable_rethrow } from "next/navigation";
import { vehicles } from "@/db/schema";
import { storeAttachment } from "@/lib/attachments";
import { NotSignedInError, type SessionUser } from "@/lib/auth";
import { withSessionActor } from "@/lib/auth/context";
import { DbGuardError } from "@/lib/db/errors";
import type { Tx } from "@/lib/db/types";
import { isUuid } from "@/lib/db/uuid";
import { FileRejectedError } from "@/lib/files";
import {
  addFinding,
  addPartsRequest,
  addPlannedService,
  assignMechanic,
  checkOdometer,
  ClientInputError,
  correctFinding,
  createClient,
  findByQrToken,
  handOver,
  INTAKE_SLOTS,
  IntakePhotoReusedError,
  OdometerReasonRequiredError,
  OwnerQuestionRequiredError,
  qualityCheck,
  receiveVehicle,
  recordRemovedPart,
  reprintSticker,
  sendToWarehouse,
  startWork,
} from "@/lib/intake";
import { cancelJob, ContractDecisionRequiredError, OpenJobExistsError } from "@/lib/jobs";
import { PermissionError, requirePermission } from "@/lib/permissions";
import { createVehicle, isValidVin, normalizeVin, recordPlate } from "@/lib/vehicles";

// Server actions for the formen's tablet (spec 01; plan 04). Each runs as the signed-in
// user (withSessionActor); a known refusal returns to the page as a translation key (?e=).

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function errorKey(e: unknown): string {
  if (e instanceof PermissionError) return "notPermitted";
  if (e instanceof OwnerQuestionRequiredError) return "ownerQuestion";
  if (e instanceof ContractDecisionRequiredError) return "contractDecision";
  if (e instanceof OdometerReasonRequiredError) return "odometerReason";
  if (e instanceof OpenJobExistsError) return "openJob";
  if (e instanceof FileRejectedError) return "fileRejected";
  if (e instanceof IntakePhotoReusedError) return "photosReused";
  if (e instanceof DbGuardError) return "conditionsMissing";
  if (e instanceof ClientInputError) return "invalidInput";
  return "generic";
}

function withError(back: string, key: string): string {
  return `${back}${back.includes("?") ? "&" : "?"}e=${key}`;
}

/** A `back` URL from a form: only a path on the intake screen, never anywhere else. */
function intakeBack(form: FormData): string {
  const back = text(form, "back");
  return /^\/qebul\?[\w=&%.+-]*$/.test(back) ? back : "/qebul";
}

/** A job id from a form, as a path segment that cannot leave /is/. */
function jobIdOf(form: FormData): string {
  const id = text(form, "jobId");
  return isUuid(id) ? id : "";
}

/**
 * Runs fn as the signed-in user in one transaction. A redirect from inside fn rolls the
 * transaction back and is passed on; a known refusal goes back to `back` with its key.
 */
async function act<T>(back: string, fn: (tx: Tx, user: SessionUser) => Promise<T>): Promise<T> {
  try {
    return await withSessionActor(fn);
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof NotSignedInError) redirect("/");
    const key = errorKey(e);
    if (key === "generic") console.error(e);
    redirect(withError(back, key));
  }
}

async function fileBytes(file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) return null;
  return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type };
}

function dataUrlBytes(dataUrl: string) {
  const m = /^data:(image\/png);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { bytes: new Uint8Array(Buffer.from(m[2]!, "base64")), mimeType: m[1]! };
}

/** Stores every file in `name`; the permission is checked before any byte is kept. */
async function storeFiles(tx: Tx, form: FormData, name: string): Promise<string[]> {
  const ids: string[] = [];
  for (const f of form.getAll(name)) {
    const file = await fileBytes(f);
    if (file) ids.push((await storeAttachment(tx, file)).id);
  }
  return ids;
}

/** A whole number of km, or NaN; an empty field is not 0. */
function kilometres(value: string): number {
  const digits = value.replace(/\s/g, "");
  return /^\d{1,9}$/.test(digits) ? Number(digits) : NaN;
}

// --- Intake wizard (spec 01, 3.2-3.5) --------------------------------------------------

export async function identifyByQr(form: FormData) {
  // The sticker holds a URL ending in the token, or the token itself.
  const token = text(form, "token").split("/").pop() ?? "";
  const found = await act("/qebul", (tx) => findByQrToken(tx, token));
  if (!found) redirect("/qebul?e=notFound");
  redirect(`/qebul?v=${found.vehicleId}${found.replaced ? "&rs=1" : ""}`);
}

export async function identifyByVin(form: FormData) {
  const vin = normalizeVin(text(form, "vin"));
  if (!isValidVin(vin)) redirect("/qebul?e=invalidVin");
  const [v] = await act("/qebul", (tx) =>
    tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, vin)),
  );
  redirect(v ? `/qebul?v=${v.id}` : `/qebul?nv=${vin}`);
}

export async function createVehicleAction(form: FormData) {
  const vin = normalizeVin(text(form, "vin"));
  const plate = text(form, "plate");
  const { id, conflicts } = await act(`/qebul?nv=${encodeURIComponent(vin)}`, (tx) =>
    createVehicle(tx, {
      vin,
      make: text(form, "make") || undefined,
      model: text(form, "model") || undefined,
      year: Number(text(form, "year")) || undefined,
      engine: text(form, "engine") || undefined,
      decodeSource: "MANUAL",
      plate: plate ? { display: plate, source: "INTAKE" } : undefined,
    }),
  );
  // The VIN was just typed from the car (nw=1): recorded as NEW_VEHICLE at "Saxla".
  redirect(`/qebul?v=${id}&ok=1&nw=1${conflicts.length ? "&pc=1" : ""}`);
}

export async function changePlateAction(form: FormData) {
  const v = text(form, "v");
  const back = `/qebul?v=${encodeURIComponent(v)}&ok=1`;
  const result = await act(back, (tx) =>
    recordPlate(tx, { vehicleId: v, plateDisplay: text(form, "plate"), source: "INTAKE" }),
  );
  redirect(`${back}${result.conflicts.length ? "&pc=1" : ""}`);
}

export async function createClientAction(form: FormData) {
  const back = intakeBack(form);
  const id = await act(back, (tx) =>
    createClient(tx, {
      kind: text(form, "kind") === "HUQUQI" ? "HUQUQI" : "FIZIKI",
      name: text(form, "name"),
      voen: text(form, "voen"),
      phone: text(form, "phone"),
      email: text(form, "email"),
    }),
  );
  redirect(`${back}&c=${id}`);
}

export async function uploadIntakePhotos(form: FormData) {
  const back = intakeBack(form);
  const vehicleId = new URLSearchParams(back.split("?")[1]).get("v") ?? "";
  const km = kilometres(text(form, "km"));
  const reason = text(form, "reason");
  const ids = await act(back, async (tx) => {
    await requirePermission(tx, "CREATE_JOB");
    // The odometer first: a refused reading should not cost six uploads.
    await checkOdometer(tx, vehicleId, { valueKm: km, reason });
    const out: string[] = [];
    for (const slot of INTAKE_SLOTS) {
      const file = await fileBytes(form.get(`photo_${slot}`));
      if (!file) redirect(withError(back, "photosMissing"));
      out.push((await storeAttachment(tx, file)).id);
    }
    return out;
  });
  const r = reason ? `&r=${encodeURIComponent(reason)}` : "";
  redirect(`${back}&p=${ids.join(".")}&km=${km}${r}`);
}

export async function saveIntake(form: FormData) {
  const back = intakeBack(form);
  const params = new URLSearchParams(back.split("?")[1]);
  const photoIds = (params.get("p") ?? "").split(".");
  const signature = dataUrlBytes(text(form, "signature"));
  if (!signature) redirect(withError(back, "signatureMissing"));
  const result = await act(back, async (tx, user) => {
    await requirePermission(tx, "CREATE_JOB");
    const sig = await storeAttachment(tx, signature);
    return receiveVehicle(tx, {
      vehicleId: params.get("v")!,
      contragentId: params.get("c")!,
      formenId: user.userId,
      mechanicId: text(form, "mechanicId") || undefined,
      complaints: text(form, "complaints"),
      ownerChanged: params.has("oc") ? params.get("oc") === "1" : undefined,
      contractDecision:
        (params.get("cd") as "SEPARATE_PAID" | "HOLD_FOR_MANAGEMENT" | null) ?? undefined,
      photos: Object.fromEntries(INTAKE_SLOTS.map((slot, i) => [slot, photoIds[i]!])) as Record<
        (typeof INTAKE_SLOTS)[number],
        string
      >,
      odometer: {
        valueKm: kilometres(params.get("km") ?? ""),
        reason: params.get("r") ?? undefined,
      },
      confirmation: {
        signerName: text(form, "signerName"),
        signerPhone: text(form, "signerPhone"),
        signatureAttachmentId: sig.id,
      },
      vinCheck: params.get("nw") === "1" ? "NEW_VEHICLE" : "LAST6_CONFIRMED",
    });
  });
  const flags = `${result.belowPrevious || result.aboveDailyLimit ? "&od=1" : ""}`;
  const sticker = result.newStickerToken ? `&st=${result.newStickerToken}` : "";
  redirect(`/is/${result.jobId}?yeni=1${flags}${sticker}`);
}

// --- Job card (spec 01, 3.6-3.7) -------------------------------------------------------

/**
 * 4.1 Tapıntı əlavə et: a finding (or a correction of one, with its reason), the planned
 * service and the parts it needs, in one transaction. The database marks them additional
 * once the estimate is with the client (0028).
 */
export async function saveFindingAction(form: FormData) {
  const jobId = jobIdOf(form);
  const findingId = text(form, "findingId");
  const back = `/is/${jobId}/tapinti${findingId ? `?duzelt=${encodeURIComponent(findingId)}` : ""}`;
  await act(back, async (tx) => {
    await requirePermission(tx, "RECORD_INSPECTION");
    const description = text(form, "description");
    const ids = await storeFiles(tx, form, "files");
    if (description || findingId) {
      if (ids.length === 0) redirect(withError(back, "findingNeedsPhoto"));
      const input = { mechanicId: text(form, "mechanicId"), description, attachmentIds: ids };
      if (findingId) await correctFinding(tx, findingId, input, text(form, "reason"));
      else await addFinding(tx, jobId, input);
    }
    const service = text(form, "service");
    if (service) {
      await addPlannedService(tx, jobId, {
        description: service,
        mechanicId: text(form, "mechanicId") || undefined,
      });
    }
    const names = form.getAll("partName").map(String);
    const qtys = form.getAll("partQty").map(String);
    const units = form.getAll("partUnit").map(String);
    for (const [i, name] of names.entries()) {
      if (!name.trim()) continue;
      await addPartsRequest(tx, jobId, {
        description: name,
        quantity: (qtys[i] ?? "1").trim().replace(",", ".") || "1",
        unitHint: units[i] ?? "",
      });
    }
  });
  redirect(`/is/${jobId}`);
}

export async function assignMechanicAction(form: FormData) {
  const jobId = jobIdOf(form);
  await act(`/is/${jobId}`, (tx) => assignMechanic(tx, jobId, text(form, "mechanicId")));
  redirect(`/is/${jobId}`);
}

export async function sendToWarehouseAction(form: FormData) {
  const jobId = jobIdOf(form);
  await act(`/is/${jobId}`, (tx) => sendToWarehouse(tx, jobId));
  redirect("/isler");
}

export async function startWorkAction(form: FormData) {
  const jobId = jobIdOf(form);
  await act(`/is/${jobId}`, (tx) => startWork(tx, jobId));
  redirect(`/is/${jobId}`);
}

/** 5.2 Köhnə hissə: the old part's photo, who replaced it and what happens to it (R7). */
export async function removedPartAction(form: FormData) {
  const jobId = jobIdOf(form);
  const back = `/is/${jobId}/kohne`;
  await act(back, async (tx) => {
    await requirePermission(tx, "RECORD_INSPECTION");
    const part = text(form, "part");
    const description = part === "other" || !part ? text(form, "otherPart") : part;
    if (!description) redirect(withError(back, "invalidInput"));
    const photo = await fileBytes(form.get("photo"));
    if (!photo) redirect(withError(back, "photosMissing"));
    const { id } = await storeAttachment(tx, photo);
    return recordRemovedPart(tx, jobId, {
      description,
      photoId: id,
      disposition: text(form, "disposition") as
        "RETURNED_TO_CLIENT" | "DISPOSED" | "WARRANTY_CLAIM",
      mechanicId: text(form, "mechanicId") || undefined,
    });
  });
  redirect(`/is/${jobId}`);
}

/** 5.3 Keyfiyyət yoxlaması: "Uğurlu: Hazır et" or "Uğursuz: təmirdə qalsın". */
export async function qualityCheckAction(form: FormData) {
  const jobId = jobIdOf(form);
  const back = `/is/${jobId}/yoxlama`;
  const passed = await act(back, async (tx) => {
    await requirePermission(tx, "RECORD_INSPECTION");
    const photo = await fileBytes(form.get("dashboard"));
    if (!photo) redirect(withError(back, "photosMissing"));
    const { id } = await storeAttachment(tx, photo);
    const items = Object.fromEntries(form.getAll("items").map((i) => [String(i), true]));
    return qualityCheck(tx, jobId, {
      items,
      dashboardPhotoId: id,
      mechanicId: text(form, "mechanicId") || undefined,
      failed: text(form, "result") === "fail",
    });
  });
  redirect(`/is/${jobId}${passed ? "" : "?qc=0"}`);
}

/** 6.1 Təhvil-Təslim: the act is numbered and signed by the person collecting the car. */
export async function handOverAction(form: FormData) {
  const jobId = jobIdOf(form);
  const back = `/is/${jobId}/tehvil`;
  const signature = dataUrlBytes(text(form, "signature"));
  if (!signature) redirect(withError(back, "signatureMissing"));
  await act(back, async (tx) => {
    await requirePermission(tx, "RECORD_INSPECTION");
    const sig = await storeAttachment(tx, signature);
    return handOver(tx, jobId, {
      signerName: text(form, "signerName"),
      signerPhone: text(form, "signerPhone"),
      signatureAttachmentId: sig.id,
    });
  });
  redirect(`/is/${jobId}`);
}

/**
 * 6.3 Ləğv et (spec 01, 6): the formen while in QEBUL, management after; the reason is the
 * chosen one and the details, in Azerbaijani as the formen saw them.
 */
export async function cancelJobAction(form: FormData) {
  const jobId = jobIdOf(form);
  const t = await getTranslations("job.reasons");
  const kind = text(form, "reasonKind");
  const details = text(form, "details");
  const label = ["refused", "wrongCar", "other"].includes(kind) ? t(kind) : "";
  const reason = [kind === "other" ? "" : label, details].filter(Boolean).join(": ");
  if (!reason) redirect(`/is/${jobId}?legv=1&e=reasonRequired`);
  await act(`/is/${jobId}?legv=1`, (tx) => cancelJob(tx, jobId, reason));
  redirect(`/is/${jobId}`);
}

/** A screen to return to: a job card or an intake step, never another site. */
function screenBack(form: FormData): string {
  const back = text(form, "back");
  if (/^\/is\/[0-9a-f-]{36}$/.test(back)) return back;
  return /^\/qebul\?[\w=&%.+-]*$/.test(back) ? back : "/isler";
}

/** Reprint from the job card or from the VIN check at intake (3.2: a lost sticker). */
export async function reprintStickerAction(form: FormData) {
  const back = screenBack(form);
  const vehicleId = text(form, "vehicleId");
  const self = `/stiker/yeni?v=${encodeURIComponent(vehicleId)}&back=${encodeURIComponent(back)}`;
  const token = await act(self, (tx) => reprintSticker(tx, vehicleId, text(form, "reason")));
  redirect(`/stiker/${token}?back=${encodeURIComponent(back)}`);
}
