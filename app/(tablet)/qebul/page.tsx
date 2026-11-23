import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/app/_components/Icon";
import { PhotoInput } from "@/app/_components/PhotoInput";
import { QrScanner } from "@/app/_components/QrScanner";
import { SignaturePad } from "@/app/_components/SignaturePad";
import { requireSessionUser } from "@/lib/auth/context";
import { checkContract } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { INTAKE_SLOTS, lastClientOf } from "@/lib/intake";
import {
  clientName,
  lastOdometer,
  lastVisitPhoto,
  mechanics,
  searchClients,
  vehicleSummary,
  type VehicleSummary,
} from "@/lib/intake/queries";
import { groupThousands } from "@/lib/money";
import { searchByPlate } from "@/lib/vehicles";
import {
  changePlateAction,
  createClientAction,
  createVehicleAction,
  identifyByQr,
  identifyByVin,
  saveIntake,
  reprintStickerAction,
  uploadIntakePhotos,
} from "../actions";
import { ErrorNote } from "../ErrorNote";
import { Plate } from "../Plate";

// Receiving a car (spec 01, 3.2-3.5), one step per screen. The step is kept in the URL:
//   pl  plate search        v   vehicle            ok  VIN last 6 confirmed   c   client
//   oc  owner changed       cd  contract decision  p   the six photo attachment ids
//   km, r  odometer and its reason
// Nothing is written to the job until "Saxla" (saveIntake), in one transaction.

type Params = Record<string, string | undefined>;
const UUID = /^[0-9a-f-]{36}$/;

function href(params: Params, extra: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries({ ...params, ...extra })) {
    if (val !== undefined && k !== "e") q.set(k, val);
  }
  return `/qebul?${q.toString()}`;
}

async function Steps({ at }: { at: 0 | 1 | 2 | 3 }) {
  const t = await getTranslations("intake.steps");
  const names = ["vehicle", "client", "photos", "confirm"] as const;
  return (
    <ol className="steps">
      {names.map((n, i) => (
        <li key={n} className={i < at ? "step done" : i === at ? "step current" : "step"}>
          {t(n)}
        </li>
      ))}
    </ol>
  );
}

async function VehicleHead({
  vehicle,
  children,
}: {
  vehicle: VehicleSummary;
  children?: ReactNode;
}) {
  const t = await getTranslations("intake");
  return (
    <div className="vehicle-head">
      <span className="vehicle-icon" aria-hidden="true">
        <Icon name="truck" size={26} />
      </span>
      <div>
        <strong>
          {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ") || vehicle.vin}
        </strong>
        <span className="mono muted">{vehicle.vin}</span>
      </div>
      <div className="ids">
        {vehicle.plate ? (
          <Plate value={vehicle.plate} />
        ) : (
          <span className="muted">{t("noPlate")}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export default async function IntakePage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireSessionUser();
  const params = await searchParams;
  const t = await getTranslations("intake");
  const tj = await getTranslations("job");
  const db = getDb();
  const self = href(params);

  // --- 1. Identify the car -------------------------------------------------------------
  if (!params.v && !params.nv) {
    // The plate is only a shortcut: every result leads to a VIN, and former plates say so.
    const plates = params.pl ? await searchByPlate(db, params.pl) : [];
    return (
      <main>
        <Steps at={0} />
        <h1>{t("identify")}</h1>
        <ErrorNote code={params.e} />
        <div className="options">
          <section className="card">
            <h2 className="option-title">
              <span className="badge-icon" aria-hidden="true">
                <Icon name="qr" />
              </span>
              {t("byQr")}
            </h2>
            <form action={identifyByQr}>
              <QrScanner inputName="token" scanLabel={t("scanQr")} />
              <div className="inline">
                <label>
                  {t("qrCode")}
                  <input name="token" required autoComplete="off" />
                </label>
                <button type="submit">
                  <Icon name="search" size={18} />
                  {t("find")}
                </button>
              </div>
            </form>
          </section>
          <section className="card">
            <h2 className="option-title">
              <span className="badge-icon" aria-hidden="true">
                <Icon name="shield" />
              </span>
              {t("byVin")}
            </h2>
            <form action={identifyByVin}>
              <div className="inline">
                <label>
                  {t("vin")}
                  <input
                    name="vin"
                    className="mono"
                    required
                    maxLength={17}
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                </label>
                <button type="submit">
                  <Icon name="search" size={18} />
                  {t("find")}
                </button>
              </div>
              <small className="muted">{t("vinHint")}</small>
            </form>
          </section>
          <section className="card">
            <h2 className="option-title">
              <span className="badge-icon" aria-hidden="true">
                <Icon name="search" />
              </span>
              {t("byPlate")}
            </h2>
            <form action="/qebul">
              <div className="inline">
                <label>
                  {t("plateSearch")}
                  <input name="pl" defaultValue={params.pl} required autoCapitalize="characters" />
                </label>
                <button type="submit">
                  <Icon name="search" size={18} />
                  {t("find")}
                </button>
              </div>
            </form>
            {params.pl && plates.length === 0 && <p className="muted">{t("notFound")}</p>}
            {plates.some((r) => r.label === "UNCONFIRMED") && (
              <p role="alert">{t("plateElsewhere")}</p>
            )}
            {plates.length > 0 && (
              <ul className="results">
                {plates.map((r) => (
                  <li key={`${r.vehicleId}-${r.plateDisplay}-${r.validFrom}`}>
                    <Link href={href({ v: r.vehicleId })}>
                      <Icon name="truck" />
                      {t("plateResult", {
                        plate: r.plateDisplay,
                        label: t(`plateLabel.${r.label}`, {
                          date: r.usedUntil?.split("-").reverse().join(".") ?? "",
                        }),
                        vehicle: [r.make, r.model].filter(Boolean).join(" "),
                        vin: r.vin,
                      })}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    );
  }

  // --- 1b. A VIN the system does not know: a new car ---------------------------------------
  if (params.nv) {
    return (
      <main>
        <Steps at={0} />
        <h1>{t("newVehicle")}</h1>
        <ErrorNote code={params.e} />
        <form action={createVehicleAction} className="card">
          <label>
            {t("vin")}
            <input name="vin" className="mono" defaultValue={params.nv} readOnly />
          </label>
          <div className="row">
            <label>
              {t("make")}
              <input name="make" />
            </label>
            <label>
              {t("model")}
              <input name="model" />
            </label>
          </div>
          <div className="row">
            <label>
              {t("year")}
              <input name="year" inputMode="numeric" maxLength={4} />
            </label>
            <label>
              {t("engine")}
              <input name="engine" />
            </label>
            <label>
              {t("plate")}
              <input name="plate" autoCapitalize="characters" />
            </label>
          </div>
          <button type="submit" className="primary large">
            {t("create")}
          </button>
        </form>
        <Link href="/qebul" className="back">
          <Icon name="back" size={18} />
          {t("otherVehicle")}
        </Link>
      </main>
    );
  }

  if (!UUID.test(params.v!)) notFound();
  const vehicle = await vehicleSummary(db, params.v!);
  if (!vehicle) notFound();

  // --- 1c. The VIN on the car must match: the last six characters (3.2) --------------------
  if (!params.ok) {
    const photo = await lastVisitPhoto(db, vehicle.id);
    const last6 = vehicle.vin.slice(-6);
    return (
      <main>
        <Steps at={0} />
        {params.rs && <p role="alert">{t("replacedSticker")}</p>}
        <VehicleHead vehicle={vehicle} />
        <section className="card vin-check">
          {photo && (
            <figure className="last-photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- served by /fayl */}
              <img src={`/fayl/${photo}`} alt={t("lastVisitPhoto")} />
              <figcaption className="muted">{t("lastVisitPhoto")}</figcaption>
            </figure>
          )}
          <p className="big">{t("confirmVin", { last6 })}</p>
          <p className="vin-full">
            {vehicle.vin.slice(0, -6)}
            <mark>{last6}</mark>
          </p>
          <div className="choices">
            <Link className="btn primary large" href={href(params, { ok: "1" })}>
              <Icon name="check" />
              {t("vinMatches")}
            </Link>
            <Link className="btn large" href="/qebul">
              {t("otherVehicle")}
            </Link>
          </div>
        </section>
        <details className="more">
          <summary>
            <Icon name="printer" size={18} />
            {t("lostSticker")}
          </summary>
          <form action={reprintStickerAction} className="card">
            <input type="hidden" name="vehicleId" value={vehicle.id} />
            <input type="hidden" name="back" value={self} />
            <div className="inline">
              <label>
                {tj("reprintReason")}
                <input name="reason" required />
              </label>
              <button type="submit">{tj("reprintSticker")}</button>
            </div>
          </form>
        </details>
      </main>
    );
  }

  if (vehicle.openJobId) {
    return (
      <main>
        <Steps at={0} />
        <VehicleHead vehicle={vehicle} />
        <p className="notice info">{t("openJobExists")}</p>
        <Link className="btn primary large" href={`/is/${vehicle.openJobId}`}>
          {t("openJobLink")}
        </Link>
      </main>
    );
  }

  // --- 2. Client ------------------------------------------------------------------------------
  if (!params.c) {
    const lastId = await lastClientOf(db, vehicle.id);
    const lastName = lastId ? await clientName(db, lastId) : null;
    const results = params.q ? await searchClients(db, params.q) : [];
    return (
      <main>
        <Steps at={1} />
        <h1>{t("client")}</h1>
        <ErrorNote code={params.e} />
        <VehicleHead vehicle={vehicle} />
        {params.pc && <p role="alert">{t("plateElsewhere")}</p>}
        {lastId && lastName && (
          <section className="card">
            <p className="muted">{t("lastClient", { name: lastName })}</p>
            <Link className="choice" href={href(params, { c: lastId })}>
              <Icon name="user" />
              <span>{lastName}</span>
              <span className="btn primary push">{t("choose")}</span>
            </Link>
          </section>
        )}
        <section className="card">
          <form action="/qebul">
            <input type="hidden" name="v" value={vehicle.id} />
            <input type="hidden" name="ok" value="1" />
            <div className="inline">
              <label>
                {t("clientSearch")}
                <input name="q" defaultValue={params.q} minLength={2} required />
              </label>
              <button type="submit">
                <Icon name="search" size={18} />
                {t("find")}
              </button>
            </div>
          </form>
          {params.q && results.length === 0 && <p className="muted">{t("noClients")}</p>}
          {results.length > 0 && (
            <ul className="results">
              {results.map((r) => (
                <li key={r.id}>
                  <Link href={href(params, { c: r.id, q: undefined })}>
                    <Icon name="user" />
                    <span>
                      <strong>{r.name}</strong>
                      <span className="muted">{r.phone ?? r.voen}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <details className="more">
            <summary>
              <Icon name="plus" size={18} />
              {t("newClient")}
            </summary>
            <form action={createClientAction}>
              <input type="hidden" name="back" value={href(params, { q: undefined })} />
              <label>
                {t("kind")}
                <select name="kind">
                  <option value="FIZIKI">{t("FIZIKI")}</option>
                  <option value="HUQUQI">{t("HUQUQI")}</option>
                </select>
              </label>
              <label>
                {t("name")}
                <input name="name" required />
              </label>
              <div className="row">
                <label>
                  {t("phone")}
                  <input name="phone" type="tel" />
                </label>
                <label>
                  {t("voen")}
                  <input name="voen" inputMode="numeric" maxLength={10} />
                </label>
              </div>
              <label>
                {t("email")}
                <input name="email" type="email" />
              </label>
              <button type="submit" className="primary">
                {t("create")}
              </button>
            </form>
          </details>
          <details className="more">
            <summary>
              <Icon name="pen" size={18} />
              {t("plateChanged")}
            </summary>
            <form action={changePlateAction}>
              <input type="hidden" name="v" value={vehicle.id} />
              <div className="inline">
                <label>
                  {t("plate")}
                  <input name="plate" required autoCapitalize="characters" />
                </label>
                <button type="submit">{t("save")}</button>
              </div>
            </form>
          </details>
        </section>
      </main>
    );
  }

  if (!UUID.test(params.c)) notFound();
  const client = await clientName(db, params.c);
  if (!client) notFound();
  const clientLine = (
    <p className="notice info">
      <Icon name="user" />
      {t("clientLine", { name: client })}
    </p>
  );

  // A different client from the last visit: did the car change hands? (spec 00, 3a)
  const lastId = await lastClientOf(db, vehicle.id);
  if (lastId && lastId !== params.c && !params.oc) {
    return (
      <main>
        <Steps at={1} />
        <h1>{t("ownerChanged")}</h1>
        <VehicleHead vehicle={vehicle} />
        {clientLine}
        <div className="choices">
          <Link className="choice" href={href(params, { oc: "1" })}>
            {t("yes")}
          </Link>
          <Link className="choice" href={href(params, { oc: "0" })}>
            {t("no")}
          </Link>
        </div>
      </main>
    );
  }

  // The contract check by VIN (spec 01, 3.3); a warning needs the formen's decision.
  const { check } = await checkContract(db, { vehicleId: vehicle.id, contragentId: params.c });
  if ((check === "NOT_ON_CONTRACT" || check === "CONTRACT_EXPIRED") && !params.cd) {
    return (
      <main>
        <Steps at={1} />
        <h1>{check === "NOT_ON_CONTRACT" ? t("notOnContract") : t("contractExpired")}</h1>
        <VehicleHead vehicle={vehicle} />
        {clientLine}
        <div className="choices">
          <Link className="choice" href={href(params, { cd: "SEPARATE_PAID" })}>
            {t("separatePaid")}
          </Link>
          <Link className="choice" href={href(params, { cd: "HOLD_FOR_MANAGEMENT" })}>
            {t("holdForManagement")}
          </Link>
        </div>
      </main>
    );
  }

  // --- 3. Photos and odometer (3.4) ----------------------------------------------------------
  const previousKm = await lastOdometer(db, vehicle.id);
  if (!params.p) {
    return (
      <main>
        <Steps at={2} />
        <h1>{t("photos")}</h1>
        <ErrorNote code={params.e} />
        <VehicleHead vehicle={vehicle} />
        <form action={uploadIntakePhotos} className="card">
          <input type="hidden" name="back" value={self} />
          <p className="muted">{t("photosHint")}</p>
          <div className="photo-grid">
            {INTAKE_SLOTS.map((slot) => (
              <PhotoInput
                key={slot}
                name={`photo_${slot}`}
                label={t(`slot.${slot}`)}
                hint={t("takePhoto")}
                required
              />
            ))}
          </div>
          <div className="row">
            <label>
              {t("odometer")}
              <input name="km" inputMode="numeric" pattern="[0-9]+" required />
              <small>
                {previousKm === null
                  ? t("kmFirst")
                  : t("odometerPrevious", { km: groupThousands(previousKm) })}
              </small>
            </label>
            <label>
              {t("reason")}
              <input name="reason" />
              <small>{t("odometerReasonHint")}</small>
            </label>
          </div>
          <button type="submit" className="primary large">
            {t("continue")}
          </button>
        </form>
      </main>
    );
  }

  // --- 4. Complaints and the driver's confirmation (3.5) -------------------------------------
  const staff = await mechanics(db);
  return (
    <main>
      <Steps at={3} />
      <h1>{t("title")}</h1>
      <ErrorNote code={params.e} />
      <VehicleHead vehicle={vehicle} />
      {clientLine}
      <p className="notice ok">
        <Icon name="gauge" />
        {t("summary", { km: groupThousands(Number(params.km ?? 0)) })}
      </p>
      <form action={saveIntake} className="card">
        <input type="hidden" name="back" value={self} />
        <label>
          {t("complaints")}
          <textarea name="complaints" rows={4} required />
        </label>
        <label>
          {t("mechanicOptional")}
          <select name="mechanicId" defaultValue="">
            <option value="" />
            {staff.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t("confirmation")}</legend>
          <div className="row">
            <label>
              {t("signerName")}
              <input name="signerName" required />
            </label>
            <label>
              {t("signerPhone")}
              <input name="signerPhone" type="tel" required />
            </label>
          </div>
          <SignaturePad name="signature" clearLabel={t("clearSignature")} />
        </fieldset>
        <button type="submit" className="primary large">
          <Icon name="check" />
          {t("save")}
        </button>
      </form>
    </main>
  );
}
