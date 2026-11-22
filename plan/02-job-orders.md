# Plan 02: Job orders, lifecycle, contracts (milestone 2)

Status: ACCEPTED 2026-11-22.
Sources:
- spec/00-backbone.md §3 (job orders, contracts), §3a (snapshots, contract lists), §4 (lifecycle), §13 AC1;
- spec/01-foreman-intake.md §3.2.3, §3.3, §6, AC1a and AC5;
- RISKS.md R1, R3, R21 and R25;
- skills `audit-rules` and `document-numbering`;
- plan/01-foundations.md (the conventions here follow it).

## Context

Milestone 1 built the database guarantees. Every module now needs the job order: the visit that photos, findings, documents and payments attach to. This milestone adds:
- job orders with a lifecycle that the database enforces;
- the job's status history;
- contracts and contract vehicles, with the intake contract check by VIN;
- the foreign keys that milestone 1 left open (`documents.job_order_id`, `vehicle_plates.job_order_id`).

It has no screens; those are milestone 4. Role checks are milestone 3: this milestone records who acted, and milestone 3 decides who may act.

## Decisions (Aykhan 2026-11-22; Claude decides the rest autonomously, as Aykhan asked)

| # | Decision |
| --- | --- |
| Q1 | **Payment and handover in either order.** HAZIR → ODENILDI → TEHVIL_VERILDI, or HAZIR → TEHVIL_VERILDI → ODENILDI. Whichever comes second moves the job to BAGLANDI automatically, in the same transaction. |
| Q2 | **Cancelling (LEGV) follows spec 01 §6.** The formen cancels while the job is in QEBUL; management cancels from BAXIS onwards. Never after TEHVIL_VERILDI or ODENILDI. The database enforces "until when". The role check comes in M3; until then the canceller is recorded. |
| Q3 | **Backward steps, each needing a reason (Claude's choice):** TESDIQ_GOZLEYIR → QIYMETLENDIRME (the client asks for estimate changes), HAZIR → TEMIRDE (quality check failed), TEMIRDE → HISSE_GOZLEYIR (a part turns out missing during work). |
| Q4 | **`contract_approvers` and `client_portal_users` arrive in M3** with the approval engine. |
| C1 | **`auto_renew` contracts stay valid past `valid_to`** until terminated. A contract without auto-renew has expired once `valid_to` < today in Baku. |
| C2 | **A vehicle is on at most one active contract at a time** (partial unique index). A car sold to another company is first removed from the old contract (§3a). |
| C3 | **"Hold for management" (spec 01 §3.3) is a recorded decision on the job, not a new status.** The lifecycle has no such status. The management queue for it comes with the M3 approvals. |
| C4 | **Contract import and plates:** a vehicle new to the system gets the list's plate as a `CONTRACT` plate. An existing vehicle keeps its plate history; the list's plate is stored only as `contract_vehicles.contract_plate` (§3a: "a contract listing a car under an old plate needs no amendment"). |
| C5 | **Job numbers use the gapless numbering module:** series `JOB_ORDER`, prefix `IS` → `IS-2026-000001`, assigned when the job is created. This adds to open item O2 (prefixes). |
| C6 | **The spec's `opened_at` is `created_at`**, like F12. An ELAVE_AKT leaves the job in TEMIRDE (§4). |

## Lifecycle (enforced by the `job_orders_guard` trigger)

| From | Allowed to |
| --- | --- |
| (insert) | QEBUL only |
| QEBUL | BAXIS, LEGV |
| BAXIS | QIYMETLENDIRME, LEGV |
| QIYMETLENDIRME | TESDIQ_GOZLEYIR, LEGV |
| TESDIQ_GOZLEYIR | TESDIQLENDI, QIYMETLENDIRME, LEGV |
| TESDIQLENDI | HISSE_GOZLEYIR, TEMIRDE, LEGV |
| HISSE_GOZLEYIR | TEMIRDE, LEGV |
| TEMIRDE | HAZIR, HISSE_GOZLEYIR, LEGV |
| HAZIR | TEMIRDE, ODENILDI, TEHVIL_VERILDI, LEGV |
| ODENILDI | TEHVIL_VERILDI (if not yet handed over); BAGLANDI (only if a TEHVIL_VERILDI event exists) |
| TEHVIL_VERILDI | ODENILDI (if not yet paid); BAGLANDI (only if an ODENILDI event exists) |
| BAGLANDI, LEGV | nothing. Terminal rows are frozen (DM001). |

Business preconditions such as six photos, parts issued, the quality check, the signed Təhvil-Təslim aktı and confirmed payments belong to the milestones that build those tables. They will be added to `lib/jobs` (and, where they are about data, to the guard) at that point.

## Tables (schema in `db/schema/jobs.ts` and `db/schema/contracts.ts`; migration generated)

Every table has id, `created_at` and `created_by`, like milestone 1. Status columns are text with a CHECK constraint.

| Table | Columns | Constraints |
| --- | --- | --- |
| `contracts` | contragent_id FK, number (the client's paper contract number), signed_on, valid_from, valid_to (null = open-ended), auto_renew, deferred_payment_days int, advance_threshold_ex_vat numeric(14,2), advance_percent numeric(5,2), penalty_rate_daily numeric(7,4) (% per day), penalty_cap_percent numeric(5,2), status, status_reason | status ∈ ACTIVE, TERMINATED, ANNULLED; anything other than ACTIVE needs a reason. UNIQUE(contragent_id, number). valid_to ≥ valid_from. Values ≥ 0. |
| `contract_vehicles` | contract_id FK, vehicle_id FK, contract_plate text, added_on date, removed_on date, removed_by FK, remove_reason | The three removal columns are set together. **UNIQUE(vehicle_id) WHERE removed_on IS NULL** (C2). |
| `job_orders` | number, vehicle_id FK, contragent_id FK, contract_id FK, contract_check, contract_decision, status DEFAULT QEBUL, formen_id FK, mechanic_id FK, complaints, vin_snapshot, plate_snapshot, cancel_reason | number UNIQUE, CHECK `^IS-[0-9]{4}-[0-9]{6}$`. contract_check ∈ ON_CONTRACT, NOT_ON_CONTRACT, CONTRACT_EXPIRED, NO_CONTRACT. contract_decision ∈ SEPARATE_PAID, HOLD_FOR_MANAGEMENT, and is required exactly when the check is NOT_ON_CONTRACT or CONTRACT_EXPIRED. LEGV requires cancel_reason. **UNIQUE(vehicle_id) WHERE status NOT IN ('BAGLANDI','LEGV')**: one open job per car (spec 01 §3.2.3). |
| `job_status_events` | job_order_id FK, from_status (null for the first event), to_status, user_id FK, reason, at DEFAULT now() | Append-only, like `audit_log`. The app role gets SELECT only, and rows are written by a SECURITY DEFINER trigger. It has `at` instead of `created_*`. |

Foreign keys added: `documents.job_order_id` → job_orders, and `vehicle_plates.job_order_id` → job_orders. The tables are empty in production, so no `NOT VALID` step is needed.

## Hand-written migration `job_order_guards` (drafted in db/drafts, added with `pnpm db:new --from`)

- **Grants:**
  - `diesel_app` gets SELECT, INSERT and UPDATE on contracts, contract_vehicles and job_orders;
  - SELECT only on job_status_events;
  - no DELETE anywhere.
- **Standard triggers:** `stamp_created` and `audit_row` on contracts, contract_vehicles and job_orders. `forbid_delete` and `forbid_truncate` on all four new tables. `forbid_update` on job_status_events.
- **`job_orders_guard`, BEFORE INSERT OR UPDATE:**
  - **On insert:** status must be QEBUL with no cancel_reason. vin_snapshot and plate_snapshot are filled from the vehicle and its ACTIVE plate; client values are ignored (§3a).
  - **On update:**
    - terminal rows raise DM001;
    - number, vehicle_id and the snapshots raise DM005 if changed;
    - a status change must follow the table above, or DM006;
    - the conditional edges into BAGLANDI, ODENILDI and TEHVIL_VERILDI check `job_status_events`.
- **`job_status_event`, AFTER INSERT OR UPDATE OF status, SECURITY DEFINER:** inserts (from, to, current_actor(), app.reason). Every transition is recorded without depending on app code.
- **`contract_vehicles_guard`, BEFORE UPDATE:** the only allowed change is setting the three removal columns, once (DM005).
- **`documents_job_vehicle`, BEFORE INSERT OR UPDATE on documents:** when `job_order_id` is set, `vehicle_id` defaults to the job's vehicle and must equal it (DM005). This closes plan 01's F3 follow-up.

## lib modules

- **`lib/numbering`:** `assignNumber(tx, series)`, where `series` is a `DocType` or `"JOB_ORDER"`; add `JOB_ORDER: "IS"` to the prefixes. The same upsert and the same counter guards are reused.
- **`lib/contracts`:**
  - `createContract`;
  - `terminateContract(tx, id, on, reason)`;
  - `addVehicle(tx, contractId, vehicleId, contractPlate?)`;
  - `removeVehicle(tx, contractId, vehicleId, reason)`;
  - `importVehicleList(tx, contractId, rows)`: all or nothing. Rows without a VIN or with an invalid VIN are rejected, and every bad row is listed in one `ContractImportError` (§3a). It finds or creates each vehicle by VIN (C4).
  - `checkContract(tx, { vehicleId, contragentId })`, by VIN only, never by plate. It returns one of four results:

    | Result | When |
    | --- | --- |
    | `ON_CONTRACT` | the vehicle is on one of the client's contracts, and it is valid today (C1) |
    | `CONTRACT_EXPIRED` | the vehicle is on such a contract, but it is terminated, past `valid_to`, or not started yet |
    | `NOT_ON_CONTRACT` | the client has an active contract, but this vehicle isn't on it |
    | `NO_CONTRACT` | the client has no contract: an ordinary paid job, with no warning |

    Each result comes with the contract it applies to.
- **`lib/jobs`:**
  - `openJob(tx, { vehicleId, contragentId, formenId, mechanicId?, complaints, contractDecision? })`:
    - runs `checkContract`;
    - requires a decision when the result is a warning, or throws `ContractDecisionRequiredError`;
    - assigns the IS number in the same transaction and inserts the job.
  - `moveJob(tx, jobId, to, reason)`, plus `cancelJob(tx, jobId, reason)`. After ODENILDI or TEHVIL_VERILDI, `moveJob` also moves to BAGLANDI when the other one has happened (Q1, reason key `audit.jobClosed`). Each step uses `withReason`.
  - `jobHistory(tx, jobId)`: the job's status events.
- **`messages/az.json`:** new reason keys `audit.jobOpened`, `audit.jobClosed`, `audit.contractVehicleRemoved` and others.

## Files

- **New:** `db/schema/jobs.ts`, `db/schema/contracts.ts`, `lib/jobs/index.ts`, `lib/contracts/index.ts`, two migrations (generated tables, then `job_order_guards`), `tests/db/jobs-lifecycle.db.test.ts`, `tests/db/contracts.db.test.ts`.
- **Changed:**
  - `db/schema/documents.ts` and `db/schema/vehicles.ts` (the foreign keys);
  - `db/schema/index.ts`;
  - `lib/numbering/{index,prefixes}.ts` with a unit test;
  - `tests/db/catalog.db.test.ts` (new tables; job_status_events joins the append-only allowlist);
  - `messages/az.json`.

## Order of work (branch `m2-job-orders`, each step green and committed)

1. Commit this plan as `plan/02-job-orders.md`.
2. Write the schema, generate the migration (`pnpm db:new job_orders_contracts`), and extend numbering.
3. Draft `job_order_guards`, try it on a scratch database, then `pnpm db:new --from`. Extend the catalog tests. **This is the riskiest step**, as in milestone 1.
4. Build `lib/contracts` and `lib/jobs`.
5. Write the database tests below, then run lint, typecheck, all suites and `db:check` against Docker.
6. Run the verifier and spec-checker, fix what they find, then open the PR.

## Risks

- **Riskiest: the conditional lifecycle edges in the trigger.** Getting them wrong strands a job in ODENILDI or TEHVIL_VERILDI, or lets it close unpaid. Tests walk both orders, attempt every forbidden edge from every status, and attempt BAGLANDI without the second event.
- **What could break later:**
  - Milestones 4 and 5 add preconditions to transitions (photos, parts issued, the signed aktı, payments). Each must be one function in `lib/jobs`, with any data rule as its own trigger, not new edges.
  - Milestone 3 adds role checks: the LEGV "formen until QEBUL, management after" rule and "client approves".
  - Portal visibility (AC10) will rely on `job_orders.contragent_id` and `contract_id` per visit, which this milestone already stores.
- **Options not chosen:**
  - **A status-history table written by the app:** it can be skipped. The trigger can't.
  - **Paid and handed-over flags instead of states:** the spec lists them as statuses.
  - **A HOLD status:** not in spec 00 §4 (C3).
  - **Approver tables now:** Q4.

## Spec updates needed (Aykhan; Claude doesn't edit spec/)

| # | Spec text | This plan does |
| --- | --- | --- |
| F16 | §4 transition list has no edges | Uses the edge table above, including the Q3 backward steps and the Q1 either-order closing. |
| F17 | §4 LEGV "Formen" vs spec 01 §6 | Follows spec 01 (Q2), and no LEGV after handover or payment. |
| F18 | §3 `opened_at` | Maps it to `created_at` (C6). |
| F19 | §3 contracts: `auto_renew` meaning, statuses | C1; statuses ACTIVE, TERMINATED, ANNULLED. |
| F20 | §3 `contract_vehicles`: one contract per car, `contract_plate` | C2 and C4. |
| F21 | spec 01 §3.3 "put the job on hold for management" | A recorded decision, not a status (C3). |
| F22 | §3 `job_orders`: job number format | `IS-YYYY-NNNNNN` from the gapless counter (C5). |

## Proof

| # | Command or test | Proves |
| --- | --- | --- |
| P1 | `pnpm lint && pnpm typecheck` | clean |
| P2 | `docker compose up -d db && pnpm db:migrate` | the new migrations apply |
| P3 | `pnpm db:check` | append-only, and the schema matches |
| P4 | `pnpm test` (`lib/numbering/format.test.ts` includes the IS prefix) | number formats |
| P5 | `tests/db/catalog.db.test.ts` | new tables: no DELETE for the app; job_status_events SELECT only; every trigger present |
| P6 | `tests/db/jobs-lifecycle.db.test.ts` | **Paths:** both happy paths reach BAGLANDI automatically, with one event per transition (actor and reason). **Refusals:** every edge not in the table is refused (DM006). The three backward steps work with a reason. **LEGV:** allowed up to HAZIR, needs a reason, refused from TEHVIL_VERILDI and ODENILDI. BAGLANDI without the second event is refused. Terminal jobs are frozen. **Integrity:** the app can't write job_status_events; number, vehicle and snapshots are immutable; snapshots come from the database. **Numbers:** a second open job for the same car is refused, but one after BAGLANDI or LEGV works. Job numbers are gapless (IS, with concurrent opens). |
| P7 | `tests/db/contracts.db.test.ts` | **Check results:** `checkContract` returns all four results, and the plate in the contract doesn't matter (spec 01 AC1a). **Contract state:** a removed vehicle gives NOT_ON_CONTRACT; a terminated contract or one past `valid_to` gives CONTRACT_EXPIRED; auto-renew keeps a contract valid. **Integrity:** a car is on only one active contract; removal happens once and can't be undone. **Import:** the whole import is rejected, listing every row without a VIN or with an invalid one; it creates vehicles with CONTRACT plates; an existing vehicle's plate is untouched. **openJob:** requires a decision on warnings, and stores the check and the decision. **Documents:** a document on a job takes the job's vehicle, and a different vehicle is refused. |
| P8 | `pnpm test:e2e` | still green |
