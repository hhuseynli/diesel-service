import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ErrorNote } from "@/app/_ui/ErrorNote";
import { Icon } from "@/app/_ui/Icon";
import { Notice } from "@/app/_ui/Notice";
import { StepBar } from "@/app/_ui/StepBar";
import { TabletBar } from "@/app/_ui/TabletBar";
import { checkContract } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { formatDate } from "@/lib/format";
import {
  clientSummary,
  contractSummary,
  lastVisit,
  searchClients,
  type VehicleSummary,
} from "@/lib/intake/queries";
import { createClientAction } from "../actions";
import { href, type Params } from "./params";

/**
 * 3.1 Müştəri: the client (last visit's offered first), the contract check by VIN and the
 * formen's decision on a warning, and "Sahibi dəyişib?" when the client is new to the car
 * (spec 01, 3.3; spec 00, 3a). "Davam et" waits until each question is answered.
 */
export async function ClientStep({ params, vehicle }: { params: Params; vehicle: VehicleSummary }) {
  const t = await getTranslations("intake");
  const tu = await getTranslations("ui");
  const db = getDb();
  const last = await lastVisit(db, vehicle.id);
  const client = params.c ? await clientSummary(db, params.c) : null;
  const results = params.q ? await searchClients(db, params.q) : [];

  const check = client
    ? await checkContract(db, { vehicleId: vehicle.id, contragentId: client.id })
    : null;
  const contract = check?.contractId
    ? await contractSummary(db, check.contractId, vehicle.id)
    : null;
  const warning = check?.check === "NOT_ON_CONTRACT" || check?.check === "CONTRACT_EXPIRED";
  const askOwner = Boolean(client && last && last.clientId !== client.id && !params.oc);
  const why = !client
    ? t("chooseClientFirst")
    : askOwner
      ? t("ownerFirst")
      : warning && !params.cd
        ? t("decideFirst")
        : null;

  const contractLine = contract
    ? contract.validTo
      ? t("contractLine", {
          number: contract.number,
          from: formatDate(contract.validFrom),
          to: formatDate(contract.validTo),
        })
      : t("contractOpen", { number: contract.number, from: formatDate(contract.validFrom) })
    : t("noContract");
  // The fields that keep the step when the search form is sent.
  const keep = Object.entries(params).filter(
    ([k, val]) => val !== undefined && !["q", "c", "oc", "cd", "e", "new"].includes(k),
  );

  return (
    <>
      <TabletBar
        back={{ href: href(params, { ok: undefined, c: undefined }), label: tu("back") }}
        title={t("title")}
      />
      <StepBar step={2} />
      <main className="main">
        <section className="panel scroll">
          <h1 className="h-card">{t("clientTitle")}</h1>
          <ErrorNote code={params.e} />

          {client && (
            <>
              <span className="small muted">
                {last && last.clientId === client.id
                  ? t("lastClientPick", { date: formatDate(last.at) })
                  : t("searchPicked")}
              </span>
              <div className="result selected" data-testid="selected-client">
                <span className="selected-dot" aria-hidden="true">
                  <Icon name="check" size={16} stroke={2.4} />
                </span>
                <span className="result-body">
                  <strong>{client.name}</strong>
                  <span className="muted">
                    {client.voen
                      ? t.rich("kindVoen", {
                          kind: client.kind === "HUQUQI" ? t("legal") : t("natural"),
                          voen: client.voen,
                          m: (chunks) => <span className="mono">{chunks}</span>,
                        })
                      : client.kind === "HUQUQI"
                        ? t("legal")
                        : t("natural")}
                  </span>
                  {client.kind === "HUQUQI" && <span className="muted">{contractLine}</span>}
                </span>
              </div>
            </>
          )}

          {!client && last && params.new !== "1" && (
            <>
              <span className="small muted">
                {t("lastClientPick", { date: formatDate(last.at) })}
              </span>
              <Link className="result" href={href(params, { c: last.clientId })}>
                <span className="result-body">
                  <strong>{last.clientName}</strong>
                </span>
                <span className="btn primary sm">{t("choose")}</span>
              </Link>
            </>
          )}

          {params.new === "1" ? (
            <form action={createClientAction} className="field">
              <input type="hidden" name="back" value={href(params, { new: undefined })} />
              <div className="chips">
                <label className="chip">
                  <input type="radio" name="kind" value="FIZIKI" defaultChecked />
                  <Icon name="check" size={16} stroke={2.4} />
                  {t("natural")}
                </label>
                <label className="chip">
                  <input type="radio" name="kind" value="HUQUQI" />
                  <Icon name="check" size={16} stroke={2.4} />
                  {t("legal")}
                </label>
              </div>
              <div className="grid-2">
                <div className="field span-2">
                  <label htmlFor="cl-name">{t("name")}</label>
                  <input id="cl-name" className="input" name="name" required />
                </div>
                <div className="field">
                  <label htmlFor="cl-voen">{t("voen")}</label>
                  <input
                    id="cl-voen"
                    className="input mono"
                    name="voen"
                    inputMode="numeric"
                    maxLength={10}
                  />
                </div>
                <div className="field">
                  <label htmlFor="cl-phone">{t("phone")}</label>
                  <input id="cl-phone" className="input" name="phone" type="tel" />
                </div>
                <div className="field span-2">
                  <label htmlFor="cl-email">{t("email")}</label>
                  <input id="cl-email" className="input" name="email" type="email" />
                </div>
              </div>
              <div className="btn-row">
                <Link className="btn outline" href={href(params, { new: undefined })}>
                  {tu("back")}
                </Link>
                <button type="submit" className="btn primary">
                  {t("createClient")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="inline">
                <form action="/qebul" className="inline grow">
                  {keep.map(([k, val]) => (
                    <input key={k} type="hidden" name={k} value={val} />
                  ))}
                  <label className="search">
                    <Icon name="search" size={22} />
                    <input
                      className="input"
                      name="q"
                      defaultValue={params.q}
                      placeholder={t("clientSearch")}
                      aria-label={t("clientSearch")}
                      minLength={2}
                      required
                    />
                  </label>
                </form>
                <Link className="btn outline" href={href(params, { new: "1", q: undefined })}>
                  <Icon name="plus" />
                  {t("newClient")}
                </Link>
              </div>
              {params.q && results.length === 0 && <span className="muted">{t("noClients")}</span>}
              <ul className="col">
                {results.map((r) => (
                  <li key={r.id}>
                    <Link
                      className="result"
                      href={href(params, { c: r.id, q: undefined, oc: undefined, cd: undefined })}
                    >
                      <span className="result-body">
                        <strong>{r.name}</strong>
                        <span className="small muted">{r.phone ?? r.voen}</span>
                      </span>
                      <Icon name="next" />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel">
          <h2 className="h-panel">{t("contractCheck")}</h2>
          {check?.check === "ON_CONTRACT" && (
            <Notice kind="success" title={t("onContract")}>
              {contract?.contractPlate
                ? t("onContractBody", {
                    vin: vehicle.vin.slice(-6),
                    number: contract.number,
                    plate: contract.contractPlate,
                  })
                : t("onContractNoPlate", {
                    vin: vehicle.vin.slice(-6),
                    number: contract?.number ?? "",
                  })}
            </Notice>
          )}
          {warning && (
            <>
              <Notice
                kind="warn"
                title={
                  check?.check === "NOT_ON_CONTRACT" ? t("notOnContract") : t("contractExpired")
                }
              >
                {t("decisionBody")}
              </Notice>
              {(["SEPARATE_PAID", "HOLD_FOR_MANAGEMENT"] as const).map((d) => (
                <Link
                  key={d}
                  className="btn outline lg block"
                  aria-pressed={params.cd === d}
                  href={href(params, { cd: d })}
                >
                  {params.cd === d && <Icon name="check" stroke={2.4} />}
                  {d === "SEPARATE_PAID" ? t("separatePaid") : t("holdForManagement")}
                </Link>
              ))}
            </>
          )}
          {check?.check === "NO_CONTRACT" && (
            <span className="muted">
              {client?.kind === "HUQUQI" ? t("companyNoContract") : t("individualNote")}
            </span>
          )}
          {!client && <span className="muted">{t("individualNote")}</span>}
          <span className="spacer" />
          {why ? (
            <>
              <button type="button" className="btn lg block" disabled>
                {tu("continue")}
              </button>
              <span className="small muted center">{why}</span>
            </>
          ) : (
            <Link className="btn primary lg block" href={href(params, { go: "1" })}>
              {tu("continue")}
              <Icon name="arrow" />
            </Link>
          )}
        </section>

        {askOwner && client && last && (
          <div className="overlay">
            <div role="dialog" aria-modal="true" aria-labelledby="owner-title" className="dialog">
              <h2 id="owner-title">{t("ownerChanged")}</h2>
              <p>
                {t.rich("ownerBody", {
                  old: last.clientName,
                  now: client.name,
                  b: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <p className="small muted">{t("ownerNote")}</p>
              <Link className="btn primary lg block" href={href(params, { oc: "1" })}>
                {t("ownerYes")}
              </Link>
              <Link className="btn outline lg block" href={href(params, { oc: "0" })}>
                {t("ownerNo")}
              </Link>
              <Link className="btn block" href={href(params, { c: undefined })}>
                {t("goBack")}
              </Link>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
