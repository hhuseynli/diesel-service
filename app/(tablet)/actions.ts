"use server";

import { eq } from "drizzle-orm";
import { redirect, unstable_rethrow } from "next/navigation";
import { vehicles } from "@/db/schema";
import { storeAttachment } from "@/lib/attachments";
import { NotSignedInError, type SessionUser } from "@/lib/auth";
import { withSessionActor } from "@/lib/auth/context";
import { DbGuardError } from "@/lib/db/errors";
import type { Tx } from "@/lib/db/types";
import { FileRejectedError } from "@/lib/files";
import {
  addFinding,
  addPartsRequest,
  addPlannedService,
  checkOdometer,
  ClientInputError,
  createClient,
  findByQrToken,
  handOver,
  INTAKE_SLOTS,
  InspectionClosedError,
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
import { ContractDecisionRequiredError, OpenJobExistsError } from "@/lib/jobs";
import { PermissionError } from "@/lib/permissions";
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
  if (e instanceof IntakePhotoReusedError) return "photosMissing";
  if (e instanceof InspectionClosedError) return "conditionsMissing";
  if (e instanceof DbGuardError) return "conditionsMissing";
  if (e instanceof ClientInputError) return "invalidInput";
  return "generic";
}

function withError(back: string, key: string): string {
  return `${back}${back.includes("?") ? "&" : "?"}e=${key}`;
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
  const vin = text(form, "vin");
  const plate = text(form, "plate");
  const { id, conflicts } = await act(`/qebul?nv=${vin}`, (tx) =>
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
  // The VIN was just typed from the car, so it needs no separate last-6 confirmation.
  redirect(`/qebul?v=${id}&ok=1${conflicts.length ? "&pc=1" : ""}`);
}

export async function changePlateAction(form: FormData) {
  const v = text(form, "v");
  const result = await act(`/qebul?v=${v}&ok=1`, (tx) =>
    recordPlate(tx, { vehicleId: v, plateDisplay: text(form, "plate"), source: "INTAKE" }),
  );
  redirect(`/qebul?v=${v}&ok=1${result.conflicts.length ? "&pc=1" : ""}`);
}

export async function createClientAction(form: FormData) {
  const back = text(form, "back");
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

/** A whole number of km, or NaN; an empty field is not 0. */
function kilometres(value: string): number {
  return /^\d{1,9}$/.test(value) ? Number(value) : NaN;
}

export async function uploadIntakePhotos(form: FormData) {
  const back = text(form, "back");
  const vehicleId = new URLSearchParams(back.split("?")[1]).get("v") ?? "";
  const km = kilometres(text(form, "km"));
  const reason = text(form, "reason");
  const ids = await act(back, async (tx) => {
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
  const back = text(form, "back");
  const params = new URLSearchParams(back.split("?")[1]);
  const photoIds = (params.get("p") ?? "").split(".");
  const signature = dataUrlBytes(text(form, "signature"));
  if (!signature) redirect(withError(back, "signatureMissing"));
  const result = await act(back, async (tx, user) => {
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
    });
  });
  const flags = `${result.belowPrevious || result.aboveDailyLimit ? "&od=1" : ""}`;
  const sticker = result.newStickerToken ? `&st=${result.newStickerToken}` : "";
  redirect(`/is/${result.jobId}?yeni=1${flags}${sticker}`);
}

// --- Job card (spec 01, 3.6-3.7) -------------------------------------------------------

export async function addFindingAction(form: FormData) {
  const jobId = text(form, "jobId");
  const back = `/is/${jobId}`;
  await act(back, async (tx) => {
    const ids: string[] = [];
    for (const f of form.getAll("files")) {
      const file = await fileBytes(f);
      if (file) ids.push((await storeAttachment(tx, file)).id);
    }
    if (ids.length === 0) redirect(withError(back, "findingNeedsPhoto"));
    return addFinding(tx, jobId, {
      mechanicId: text(form, "mechanicId"),
      description: text(form, "description"),
      attachmentIds: ids,
    });
  });
  redirect(back);
}

export async function addServiceAction(form: FormData) {
  const jobId = text(form, "jobId");
  await act(`/is/${jobId}`, (tx) =>
    addPlannedService(tx, jobId, {
      description: text(form, "description"),
    }),
  );
  redirect(`/is/${jobId}`);
}

export async function addPartAction(form: FormData) {
  const jobId = text(form, "jobId");
  await act(`/is/${jobId}`, (tx) =>
    addPartsRequest(tx, jobId, {
      description: text(form, "description"),
      quantity: text(form, "quantity").replace(",", "."),
      unitHint: text(form, "unit"),
    }),
  );
  redirect(`/is/${jobId}`);
}

export async function sendToWarehouseAction(form: FormData) {
  const jobId = text(form, "jobId");
  await act(`/is/${jobId}`, (tx) => sendToWarehouse(tx, jobId));
  redirect("/isler");
}

export async function startWorkAction(form: FormData) {
  const jobId = text(form, "jobId");
  await act(`/is/${jobId}`, (tx) => startWork(tx, jobId));
  redirect(`/is/${jobId}`);
}

export async function removedPartAction(form: FormData) {
  const jobId = text(form, "jobId");
  const back = `/is/${jobId}`;
  await act(back, async (tx) => {
    const photo = await fileBytes(form.get("photo"));
    if (!photo) redirect(withError(back, "photosMissing"));
    const { id } = await storeAttachment(tx, photo);
    return recordRemovedPart(tx, jobId, {
      description: text(form, "description"),
      photoId: id,
      disposition: text(form, "disposition") as
        "RETURNED_TO_CLIENT" | "DISPOSED" | "WARRANTY_CLAIM",
    });
  });
  redirect(back);
}

export async function qualityCheckAction(form: FormData) {
  const jobId = text(form, "jobId");
  const back = `/is/${jobId}`;
  const passed = await act(back, async (tx) => {
    const photo = await fileBytes(form.get("dashboard"));
    if (!photo) redirect(withError(back, "photosMissing"));
    const { id } = await storeAttachment(tx, photo);
    const items = Object.fromEntries(form.getAll("items").map((i) => [String(i), true]));
    return qualityCheck(tx, jobId, { items, dashboardPhotoId: id, notes: text(form, "notes") });
  });
  redirect(`${back}${passed ? "" : "?qc=0"}`);
}

export async function handOverAction(form: FormData) {
  const jobId = text(form, "jobId");
  const back = `/is/${jobId}`;
  const signature = dataUrlBytes(text(form, "signature"));
  if (!signature) redirect(withError(back, "signatureMissing"));
  await act(back, async (tx) => {
    const sig = await storeAttachment(tx, signature);
    return handOver(tx, jobId, {
      signerName: text(form, "signerName"),
      signerPhone: text(form, "signerPhone"),
      signatureAttachmentId: sig.id,
    });
  });
  redirect("/isler");
}

export async function reprintStickerAction(form: FormData) {
  const jobId = text(form, "jobId");
  const token = await act(`/is/${jobId}`, (tx) =>
    reprintSticker(tx, text(form, "vehicleId"), text(form, "reason")),
  );
  redirect(`/stiker/${token}`);
}
