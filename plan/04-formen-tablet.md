# Plan 04: Formen tablet screens, thin end to end (milestone 4)

Status: ACCEPTED 2026-11-22 (Claude, autonomously as Aykhan asked). Branch `m4-formen-tablet`, based on `m3-approvals-auth`; rebased onto main once PR 3 merges.

Sources:
- spec/01-foreman-intake.md, all of it;
- spec/00 §3 (`odometer_readings`), §3a (plates, change of owner), §4, §8 (files) and §10 (the tablet);
- RISKS.md R2, R3, R8, R9, R19 and R25;
- skills `azerbaijani-ui`, `audit-rules` and `document-numbering`;
- plans 01–03.

## Context

The backbone exists: job orders and their lifecycle, contracts, approvals, permissions, PIN sign-in. What's missing is the work the formen does on the shared tablet: receiving a car, inspecting it, and moving it through the workshop to handover. "Thin end to end" means every step in spec 01 exists and works on the tablet, with the simplest acceptable form of each. Depth (offline queueing, a VIN decoder, label printing) comes later.

## Decisions (Claude)

| # | Decision |
| --- | --- |
| B1 | **Files.** The file store sits behind an interface, `lib/files`: `put(bytes, mime)` returns a key and SHA-256, and `get(key)` reads it back. In development it is the local disk, `var/files/`, gitignored and keyed by SHA-256. Cloud object storage comes with hosting (D2, R20). An upload's attachment row and its link row are written in the same transaction. |
| B2 | **Camera-only photos.** `<input type="file" accept="image/*" capture="environment">`. A browser can't prove that a photo came from the camera, so the server also checks the image's EXIF capture time against database time (within 10 minutes) and records the result. It doesn't block; it is evidence for R2. |
| B3 | **QR scanning:** the browser's built-in `BarcodeDetector`, available in tablet Chrome, with a typed sticker code as fallback. **VIN:** typed, validated, with the last-6 confirmation (spec 01 §3.2). The VIN decoder (R19) is an interface returning "unknown" until a provider is chosen, so manual entry is the thin version. |
| B4 | **QR stickers** are printed from an HTML print page sized for 50×30 mm labels. The printer is spec 01 open question 1; any printer that the tablet or office PC can print to will do. |
| B5 | **Client confirmation at intake** is a signature on screen (a canvas saved as an attachment), with name and phone. The one-time-code option waits for message delivery in milestone 6, the same as plan 03 A1. |
| B6 | **Odometer.** `odometer_readings` (spec 00 §3) is checked against the last reading. A lower reading needs a reason and creates an owner-notification record. Sending it is milestone 6; until then, the owner's home page lists these alerts. More than 1,000 km a day (setting `odometer_max_km_per_day`) gives an amber warning, which is logged. |
| B7 | **Change of owner** (§3a). When the client differs from the vehicle's last job, the formen answers "Sahibi dəyişib?" and the answer is stored on the job (`owner_changed`). The portal visibility it feeds (AC10) comes in milestone 6. |
| B8 | **Parts issued before "start work".** Stock issues are milestone 5. Until then, TEMIRDE requires that every parts request is MATCHED or CANCELLED. After milestone 5 it requires that they are issued. This is recorded as a temporary rule. |
| B9 | **Removed parts:** a photo plus one disposition of RETURNED_TO_CLIENT, DISPOSED or WARRANTY_CLAIM (R7), required before HAZIR for each replaced part. |
| B10 | **Quality check:** the checklist items live in the setting `quality_checklist` (spec 01 open question 4). The defaults are test drive, no warning lights, fluids checked and car clean, plus a dashboard photo, and all are required before HAZIR. |
| B11 | **Handover:** the Təhvil-Təslim aktı is generated (`TEHVIL_TESLIM`, numbered, no approval steps; plan 03 F28). The collector signs on screen, and the job moves to TEHVIL_VERILDI. A PDF print comes with milestone 6. |
| B12 | **Tablet layout:** portrait 10 inch, 48 px touch targets, one main action per screen (azerbaijani-ui). Every text is in `messages/az.json`, and the glossary terms are used exactly. |

## Tables (spec 01 §2, plus odometer and removed parts)

The tables are:
- `intake_photos`;
- `intake_confirmations`;
- `inspection_findings` with `inspection_finding_attachments`;
- `planned_services`;
- `parts_requests`;
- `qr_stickers`;
- `vin_decodes`;
- `quality_checks`;
- `odometer_readings`;
- `removed_parts`.

Each has the standard triggers and grants. Findings can only be added after "Anbara göndər": a guard trigger refuses UPDATE on a finding once the job has passed BAXIS, and a correction is a new row with a reason.

**Database rules:**
- A job leaves QEBUL only with six intake photos, an odometer reading and a confirmation (spec 01 AC3).
- Every finding has a mechanic and at least one attachment (AC6).
- `qr_stickers` keeps one ACTIVE token per vehicle; a reprint marks the old token REPLACED.

## Screens (tablet, signed in by PIN)

1. **Job board (3.1):**
   - columns by status, with cards showing make and model, the last 6 VIN characters, the current plate, client, mechanic and time in status;
   - a card turns amber after a set time (setting, 24 hours);
   - buttons "Maşın qəbul et" and "Yeni maşın".
2. **Identify the car (3.2):** by QR, by VIN, or by plate as a shortcut that warns when the plate is on another car; "Nömrə dəyişib" for a new plate. A car with an open job opens that job.
3. **Client (3.3):** search and create; "Sahibi dəyişib?"; the contract warning and the formen's decision.
4. **Photos and odometer (3.4):** six slots, with "Davam et" enabled only when all six are done.
5. **Complaints and confirmation (3.5):** "Saxla" creates the job and offers a sticker print for a new vehicle.
6. **Inspection (3.6):** mechanic, findings with photos, planned services, parts requests; "Anbara göndər" moves the job to BAXIS.
7. **Job card (3.7):** start work, an additional finding (which becomes an ELAVE_AKT request), removed parts, the quality check, handover.

## Proof (outline)

- **Database tests:**
  - spec 01 AC3, AC5 and AC6;
  - the odometer rules (AC4, without sending);
  - QR replacement;
  - findings can't be edited after BAXIS;
  - HAZIR and TEHVIL_VERILDI preconditions;
  - snapshots and plate-change paths (AC1a).
- **e2e on a tablet viewport, portrait 800×1280:** a new car from start to TEHVIL_VERILDI by PIN-signed staff; a returning car by sticker code; a corporate car not on its contract.
- Every milestone 1–3 suite stays green.

## Changes during implementation

| # | Change | Why |
| --- | --- | --- |
| C1 | **B9 is recorded, not yet required.** Removed parts are recorded with a photo and a disposition, but HAZIR does not require one per replaced part. | Which parts were replaced is known only from stock issues (milestone 5). The rule moves into `job_orders_intake_guard` then, like B8. |
| C2 | **B6 alerts:** the owner's home page lists odometer readings flagged in the last 30 days (`odometerAlerts`). No separate notification table: the flags on `odometer_readings` are the record, and milestone 6 sends them through the outbox. | One source of truth for the flag. |
| C3 | **Intake photos are evidence for one job only.** `receiveVehicle` refuses six photos that are not distinct, or that another job already uses (`IntakePhotoReusedError`). | The wizard passes uploaded photo ids between steps in the URL; without this check a photo could be reused (R2). |
| C4 | **The wizard keeps its step in the URL** (`v`, `ok`, `c`, `oc`, `cd`, `p`). Photos are uploaded on "Davam et"; nothing is written to the job until "Saxla", in one transaction. "Davam et" uses required file inputs; the server refuses a missing photo either way. | No client state to lose on a reload; the database still checks everything at "Saxla". |
| C5 | **A car that was handed over has left the workshop** (`car_released`): its unpaid job doesn't block a new visit, and the intake screen treats it as a returning car. A car still in the workshop leads to its open job. | Follows the M2 open-job rule; the e2e covers both. |
| C6 | **"Yeni maşın" is not a separate button on the board.** A VIN that isn't found leads straight to the new vehicle form from "Maşın qəbul et". | One entry point; the same result. |
| C7 | **The VIN decoder is manual entry only** (`decodeSource: "MANUAL"`); `vin_decodes` is ready for a provider (R19). | Plan B3 thin version. |
| C8 | **An additional finding during work is stored with `additional = true`.** The ELAVE_AKT document it becomes is created by the warehouse in milestone 5. | Estimates are milestone 5. |
| C9 | **The e2e test takes the warehouse and approval steps through `lib`** as a WAREHOUSEMAN and MANAGEMENT user, and raises the tablet idle timeout for its own run. | Those screens come in milestones 5 and 6; dev-server compiles exceed the 3-second idle used by the auth test. |
| C10 | **Display formats:** `Quantity.formatAz()` and `groupThousands()` in `lib/money` (decimal comma, space between thousands). | azerbaijani-ui. |
| C11 | **Every tablet page checks the session itself** (`requireSessionUser`), not only the layout. | Review: Next renders a page in parallel with its layout, so a signed-out RSC request got the page's data. |
| C12 | **Rules moved from lib into the database** (migrations 0027–0030): rows are added from QEBUL until the work is done, and the database marks them additional once the estimate is with the client (TESDIQ_GOZLEYIR on); removed parts and quality checks only in TEMIRDE; every mechanic named on a work row holds MECHANIC; a planned service changes only its catalog item and mechanic; intake photos are images and finding evidence is a photo or MP4; an intake photo belongs to one job (unique). | Review: the screen decided "additional", and closed jobs accepted parts requests. |
| C13 | **Mechanic on every work row (R3):** services, removed parts and the quality check take a mechanic; the job's mechanic can be set later on the job card. | Spec 01 §1, §3.6. |
| C14 | **Corrections to findings** after inspection are new rows (`corrects_id`) with a required `correction_reason`. | Spec 01 §3.6. |
| C15 | **The VIN check is recorded** on the intake confirmation (`vin_check`: LAST6_CONFIRMED, or NEW_VEHICLE when the VIN was typed from the car). The intake photos must be the formen's own uploads from the last day. | R8; review: any attachment id could be passed as a photo. |
| C16 | **The odometer sits on the photo step** and is checked there (whole kilometres; a reason when lower), then again at "Saxla". | Spec 01 §3.4; review: an empty field became 0. |
| C17 | **The sticker carries the QR code only**; the car is shown on screen beside it. A lost sticker can be reprinted from the VIN check at intake. A reprint uses 128 random bits, and a label printed before sticker rows existed is kept as REPLACED so it still warns. | Spec 01 §3.2, §4; R8. |
| C18 | **The EXIF check never blocks** an upload: a cut-off file or an impossible date gives "no capture time". | B2. |
| C19 | **Cancelling (LEGV) is on the job card** with a reason; the formen while in QEBUL, management after (lib/permissions). The management list of cancelled jobs comes with the office screens. | Spec 01 §6. |
| C20 | **Board:** nine status lanes (a handed-over car has left the workshop, so TEHVIL_VERILDI is never on the board); each card shows the plate and the last 6 VIN characters. | Spec 01 §3.1 lists six columns; the lifecycle (spec 00 §4) has nine open statuses. |
| C21 | **Design system** in `app/globals.css` with small components (`Icon`, `PhotoInput`, `Plate`, `AuthBrand`): app bar, status colours, step indicator, photo tiles with previews, the job card built around one "next step". | B12; the first screens were unstyled. |
| C22 | **Not in this milestone, recorded:** client messages (spec 01 §5) wait for the outbox (milestone 6); services picked from the catalog (§3.6) and AC7 (warehouse queue) are milestone 5; AC2 (decoded fields) waits for R19; a checklist item added to `quality_checklist` needs its translation key, or its raw key shows. | Scope. |
| C23 | **B1 and B2 as built:** intake photos are stored at "Davam et" and linked at "Saxla" in a later transaction, through join tables rather than `attachments.linked_*`; inputs accept `image/jpeg,image/png` (findings also `video/mp4`). | Review: the decisions' wording differed from the code. |
| C24 | **Second review (migration 0031):** the guards lock the job row; a finding's `additional` and correction fields are fixed once recorded; a service's and the job's mechanic change only until HAZIR; the dashboard and removed-part photos are photos; HAZIR also waits for parts requested during work; the duplicate mechanic trigger on `job_orders` is removed (0018 covers it). | Verifier, second pass. |
| C25 | **Files are checked by their contents**, not only the type the browser declares (JPEG, PNG, WebP, MP4, PDF signatures). Bytes are written to the store before the transaction commits, so a refused action can leave an unreferenced file; the actions check permission first to keep that rare, and a clean-up of unreferenced files comes with hosting (D2). | Verifier, second pass. |
| C26 | **The quality check and a removed part always name a mechanic**: the one chosen on screen (required there), else the job's; without either, lib refuses. The columns stay nullable in the database for rows recorded before this rule. | R3. |
| C27 | **Ids from URLs and forms are checked as UUIDs** (`lib/db/uuid`), so a malformed id gives 404, not 500. | Verifier, second pass. |

### Spec updates needed (Aykhan; Claude doesn't edit spec/)

| # | Spec text | This milestone does |
| --- | --- | --- |
| F33 | spec 01 AC3 "cannot be saved without six photos…" | `receiveVehicle` refuses to save without them; the database enforces it when the job leaves QEBUL (a QEBUL row can exist only inside that transaction). |
| F34 | spec 01 §3.1 six board columns | Nine lanes (C20). |
| F35 | spec 01 §4 "random, 128-bit" token | Reprints use 128 bits; a vehicle's first token is a UUIDv4 (122 random bits) from milestone 1. Suggest "at least 122 random bits". |
| F36 | spec 00 §3a rule 2: a plate row records the visit (`job_order_id`) | A plate entered at intake is written before the job exists, so it has none; the job's `plate_snapshot` records it. |
| F37 | spec 01 §3.6 "findings can only be added" after "Anbara göndər" | They can be added until the work is done; they are additional (ELAVE_AKT) once the estimate is with the client (C12). |

## Open items that don't block this milestone

- `APP_URL` must be set in production: the sticker's QR code is built from it (otherwise from the request's Host header).

- spec 01 open questions 1–5;
- R19 (the VIN decoder provider);
- D2/R20 (cloud storage region).
