import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { QrScanner } from "@/app/_components/QrScanner";
import { SignaturePad } from "@/app/_components/SignaturePad";
import { checkContract } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { INTAKE_SLOTS, lastClientOf } from "@/lib/intake";
import { groupThousands } from "@/lib/money";
import { searchByPlate } from "@/lib/vehicles";
import {
  clientName,
  lastOdometer,
  mechanics,
  searchClients,
  vehicleSummary,
} from "@/lib/intake/queries";
import {
  changePlateAction,
  createClientAction,
  createVehicleAction,
  identifyByQr,
  identifyByVin,
  saveIntake,
  uploadIntakePhotos,
} from "../actions";
import { ErrorNote } from "../ErrorNote";

// Receiving a car (spec 01, 3.2-3.5), one step per screen. The step is kept in the URL:
//   pl  plate search        v   vehicle            ok  VIN last 6 confirmed   c   client
//   oc  owner changed       cd  contract decision      p   the six photo attachment ids
// Nothing is written to the job until "Saxla" (saveIntake), in one transaction.

type Params = Record<string, string | undefined>;

function href(params: Params, extra: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries({ ...params, ...extra })) {
    if (val !== undefined && k !== "e") q.set(k, val);
  }
  return `/qebul?${q.toString()}`;
}

export default async function IntakePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const t = await getTranslations("intake");
  const db = getDb();
  const self = href(params);

  if (!params.v && !params.nv) {
    // The plate is only a shortcut: every result leads to a VIN, and former plates say so.
    const plates = params.pl ? await searchByPlate(db, params.pl) : [];
    return (
      <main>
        <h1>{t("identify")}</h1>
        <ErrorNote code={params.e} />
        <form action={identifyByQr}>
          <QrScanner inputName="token" scanLabel={t("scanQr")} />
          <label>
            {t("qrCode")}
            <input name="token" required autoComplete="off" />
          </label>
          <button type="submit">{t("find")}</button>
        </form>
        <form action="/qebul">
          <label>
            {t("plateSearch")}
            <input name="pl" defaultValue={params.pl} required autoCapitalize="characters" />
          </label>
          <button type="submit">{t("find")}</button>
        </form>
        {params.pl && plates.length === 0 && <p className="muted">{t("notFound")}</p>}
        <ul className="choices">
          {plates.map((r) => (
            <li key={`${r.vehicleId}-${r.plateDisplay}-${r.validFrom}`}>
              <Link href={href({ v: r.vehicleId })}>
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
        <form action={identifyByVin}>
          <label>
            {t("vin")}
            <input
              name="vin"
              required
              maxLength={17}
              autoComplete="off"
              autoCapitalize="characters"
            />
            <small>{t("vinHint")}</small>
          </label>
          <button type="submit">{t("find")}</button>
        </form>
      </main>
    );
  }

  if (params.nv) {
    return (
      <main>
        <h1>{t("newVehicle")}</h1>
        <ErrorNote code={params.e} />
        <form action={createVehicleAction}>
          <label>
            {t("vin")}
            <input name="vin" defaultValue={params.nv} readOnly />
          </label>
          <label>
            {t("make")}
            <input name="make" />
          </label>
          <label>
            {t("model")}
            <input name="model" />
          </label>
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
          <button type="submit">{t("create")}</button>
        </form>
        <Link href="/qebul">{t("otherVehicle")}</Link>
      </main>
    );
  }

  const vehicle = await vehicleSummary(db, params.v!);
  if (!vehicle) notFound();
  const header = (
    <header className="vehicle">
      <strong>{[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ")}</strong>
      <span>{vehicle.vin}</span>
      <span>{vehicle.plate ? t("currentPlate", { plate: vehicle.plate }) : t("noPlate")}</span>
    </header>
  );

  // The VIN on the car must match: the formen checks its last six characters (3.2).
  if (!params.ok) {
    return (
      <main>
        <h1>{t("title")}</h1>
        {params.rs && <p role="alert">{t("replacedSticker")}</p>}
        {header}
        <p className="big">{t("confirmVin", { last6: vehicle.vin.slice(-6) })}</p>
        <Link className="primary" href={href(params, { ok: "1" })}>
          {t("vinMatches")}
        </Link>
        <Link href="/qebul">{t("otherVehicle")}</Link>
      </main>
    );
  }

  if (vehicle.openJobId) {
    return (
      <main>
        <h1>{t("title")}</h1>
        {header}
        <p role="alert">{t("openJobExists")}</p>
        <Link className="primary" href={`/is/${vehicle.openJobId}`}>
          {t("openJobLink")}
        </Link>
      </main>
    );
  }

  if (!params.c) {
    const lastId = await lastClientOf(db, vehicle.id);
    const lastName = lastId ? await clientName(db, lastId) : null;
    const results = params.q ? await searchClients(db, params.q) : [];
    return (
      <main>
        <h1>{t("client")}</h1>
        <ErrorNote code={params.e} />
        {header}
        {params.pc && <p role="alert">{t("plateElsewhere")}</p>}
        <details>
          <summary>{t("plateChanged")}</summary>
          <form action={changePlateAction}>
            <input type="hidden" name="v" value={vehicle.id} />
            <label>
              {t("plate")}
              <input name="plate" required autoCapitalize="characters" />
            </label>
            <button type="submit">{t("save")}</button>
          </form>
        </details>
        {lastId && lastName && (
          <p>
            {t("lastClient", { name: lastName })}{" "}
            <Link className="primary" href={href(params, { c: lastId })}>
              {t("choose")}
            </Link>
          </p>
        )}
        <form action="/qebul">
          <input type="hidden" name="v" value={vehicle.id} />
          <input type="hidden" name="ok" value="1" />
          <label>
            {t("clientSearch")}
            <input name="q" defaultValue={params.q} minLength={2} required />
          </label>
          <button type="submit">{t("find")}</button>
        </form>
        {params.q && results.length === 0 && <p className="muted">{t("noClients")}</p>}
        <ul className="choices">
          {results.map((r) => (
            <li key={r.id}>
              <Link href={href(params, { c: r.id, q: undefined })}>
                <strong>{r.name}</strong> <span>{r.phone ?? r.voen}</span>
              </Link>
            </li>
          ))}
        </ul>
        <details>
          <summary>{t("newClient")}</summary>
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
            <label>
              {t("voen")}
              <input name="voen" inputMode="numeric" maxLength={10} />
            </label>
            <label>
              {t("phone")}
              <input name="phone" type="tel" />
            </label>
            <label>
              {t("email")}
              <input name="email" type="email" />
            </label>
            <button type="submit">{t("create")}</button>
          </form>
        </details>
      </main>
    );
  }

  const client = await clientName(db, params.c);
  if (!client) notFound();
  const clientLine = <p>{t("clientLine", { name: client })}</p>;

  // A different client from the last visit: did the car change hands? (spec 00, 3a)
  const lastId = await lastClientOf(db, vehicle.id);
  if (lastId && lastId !== params.c && !params.oc) {
    return (
      <main>
        <h1>{t("ownerChanged")}</h1>
        {header}
        {clientLine}
        <div className="choices">
          <Link className="primary" href={href(params, { oc: "1" })}>
            {t("yes")}
          </Link>
          <Link className="primary" href={href(params, { oc: "0" })}>
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
        <h1>{check === "NOT_ON_CONTRACT" ? t("notOnContract") : t("contractExpired")}</h1>
        {header}
        {clientLine}
        <div className="choices">
          <Link className="primary" href={href(params, { cd: "SEPARATE_PAID" })}>
            {t("separatePaid")}
          </Link>
          <Link className="primary" href={href(params, { cd: "HOLD_FOR_MANAGEMENT" })}>
            {t("holdForManagement")}
          </Link>
        </div>
      </main>
    );
  }

  if (!params.p) {
    return (
      <main>
        <h1>{t("photos")}</h1>
        <ErrorNote code={params.e} />
        {header}
        <form action={uploadIntakePhotos} className="photos">
          <input type="hidden" name="back" value={self} />
          {INTAKE_SLOTS.map((slot) => (
            <label key={slot} className="photo-slot">
              {t(`slot.${slot}`)}
              <input
                type="file"
                name={`photo_${slot}`}
                accept="image/jpeg,image/png"
                capture="environment"
                required
              />
            </label>
          ))}
          <button type="submit">{t("continue")}</button>
        </form>
      </main>
    );
  }

  const previousKm = await lastOdometer(db, vehicle.id);
  const staff = await mechanics(db);
  return (
    <main>
      <h1>{t("title")}</h1>
      <ErrorNote code={params.e} />
      {header}
      {clientLine}
      <form action={saveIntake}>
        <input type="hidden" name="back" value={self} />
        <label>
          {t("odometer")}
          <input name="km" inputMode="numeric" pattern="[0-9]+" required />
          {previousKm !== null && (
            <small>{t("odometerPrevious", { km: groupThousands(previousKm) })}</small>
          )}
        </label>
        <label>
          {t("reason")}
          <input name="reason" />
          <small>{t("odometerReasonHint")}</small>
        </label>
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
          <label>
            {t("signerName")}
            <input name="signerName" required />
          </label>
          <label>
            {t("signerPhone")}
            <input name="signerPhone" type="tel" required />
          </label>
          <SignaturePad name="signature" clearLabel={t("clearSignature")} />
        </fieldset>
        <button type="submit">{t("save")}</button>
      </form>
    </main>
  );
}
