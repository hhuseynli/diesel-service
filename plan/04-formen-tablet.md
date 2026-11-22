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

## Open items that don't block this milestone

- spec 01 open questions 1–5;
- R19 (the VIN decoder provider);
- D2/R20 (cloud storage region).
