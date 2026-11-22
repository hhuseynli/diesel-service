# Spec: Formen intake, inspection and job board
From intent: intent/01-foreman-intake.md (DRAFT v2). Builds on
spec/00-backbone.md. Status: DRAFT for review. Risk IDs refer to RISKS.md.

Assumes D1 (TypeScript, Next.js PWA, PostgreSQL).

Scope note: the intent covers intake and inspection. For release 1 to carry
a car end to end, this spec also covers the formen's status actions after
inspection (start service, quality check, handover). Pricing, stock and
payments stay in the warehouse and payment specs.

---

## 1. Users and device

- One shared 10-inch tablet in the workshop, used by the formen today.
- Each person unlocks it with a personal PIN (backbone section 10). Auto-lock
  after 5 minutes idle.
- Mechanics have no login yet (R3). The formen selects the mechanic on each
  inspection and work action; the record stores both `recorded_by`
  (formen) and `mechanic_id`.

---

## 2. Additional tables

| Table | Key fields | Notes |
| --- | --- | --- |
| `intake_photos` | job_order_id, slot (ODOMETER, FRONT, REAR, LEFT, RIGHT, DASHBOARD), attachment_id | All six required. |
| `intake_confirmations` | job_order_id, method (SIGNATURE, OTP), signer_name, signer_phone, signature_attachment_id, confirmed_at | Who handed the car over. |
| `inspection_findings` | job_order_id, mechanic_id, recorded_by, description, attachment_ids | At least one photo or video each (R2). |
| `planned_services` | job_order_id, description, item_id (optional), mechanic_id | Labor lines; priced by the warehouse. |
| `parts_requests` | job_order_id, description, quantity, unit_hint, status (NEW, MATCHED, CANCELLED), matched_item_id | The warehouse's queue. |
| `qr_stickers` | vehicle_id, qr_token, printed_at, printed_by, status (ACTIVE, REPLACED), replace_reason | Reprints keep history. |
| `vin_decodes` | vin, provider, raw_response, decoded_at | Cache; decodes are never re-bought. |
| `quality_checks` | job_order_id, checked_by, mechanic_id, items_checked, passed, notes | Before `HAZIR`. |

---

## 3. Screens

### 3.1 Job board (tablet home)
- Columns by status: Qəbul, Baxış, Təsdiq gözləyir, Hissə gözləyir,
  Təmirdə, Hazır. Each card shows make and model, last 6 VIN characters, current plate,
  client, mechanic,
  and time in the current status.
- Cards that have waited longer than a threshold (setting, default 24 h)
  turn amber.
- Big buttons: "Maşın qəbul et" (scan QR) and "Yeni maşın" (no sticker).

### 3.2 Identify the car
1. Scan QR → load vehicle. Show the photo of the car from its last visit
   and the VIN. The formen confirms the VIN against the car, by scanning
   the VIN plate with the camera or checking the last 6 characters, then
   taps "VIN uyğundur". If the plate has changed, the formen enters the new
   one; it is added to the plate history.
   - Search by plate is allowed as a shortcut, but always resolves to a VIN.
     If the plate is currently linked to a different VIN than the car in
     front of the formen, a warning shows (plate moved between cars, R25).
2. No sticker → scan the VIN with the camera (text recognition) or type it.
   - Validation: 17 characters, letters I, O, Q not allowed.
   - VIN already exists → load that vehicle (sticker was lost; offer reprint).
   - New VIN → call the decoder (R19), prefill make, model, year, engine;
     the formen confirms or corrects every field. Manual entry always
     possible if decoding fails.
3. A vehicle with an open job order (not `BAGLANDI` or `LEGV`) cannot get a
   second one; the screen opens the existing job instead.

Plate changes follow backbone section 3a: entering a new plate takes one
tap ("Nömrə dəyişib"), ends the old plate, and never breaks the car's
history. A car with no plate or a transit plate can be received.

### 3.3 Client
- Returning vehicle → last client preselected; formen confirms or changes.
- Different client from the last visit → "Sahibi dəyişib?" If yes, the new
  owner is linked from this visit on, and the previous owner's visits stay
  hidden from the new owner (backbone 3a).
- Search by phone, name or VOEN. Create new: kind (fiziki/hüquqi), name,
  VOEN (required for hüquqi, 10 digits), phone, email.
- Corporate client: the system checks `contract_vehicles` by VIN. A
  different plate from the one in the contract is not a mismatch.
  - On the contract → proceed.
  - Not on the contract → warning "Bu maşın müqavilədə yoxdur". Options:
    continue as a separate paid job, or put the job on hold for
    management. Either choice is logged.
  - Expired contract → same warning.

### 3.4 Intake photos and odometer
- Six photo slots shown as a checklist; camera only, no gallery.
- Odometer: number field next to the odometer photo.
  - Lower than the last reading → red warning, reason required, owner
    notified (R9).
  - Higher than the last reading by more than a set amount per day since the
    last visit (setting, default 1,000 km/day) → amber warning, logged.
- "Davam et" stays disabled until all six photos and the odometer exist.

### 3.5 Complaints and handover confirmation
- Free text for the client's complaints, in their own words.
- Confirmation by whoever brought the car:
  - Signature on screen plus their name and phone, or
  - a one-time code sent to the client's phone or email.
- For corporate clients, the person's name and phone are always recorded
  (fallback while R1 is open).
- Saving creates the job order in `QEBUL`, prints a QR sticker for a new
  vehicle, and sends the "car received" message with the job number.

### 3.6 Inspection
- Select the mechanic (required).
- Add findings: description plus at least one photo or short video each.
- Add planned services (free text, or pick from catalog services).
- Add requested parts: description, quantity, unit hint. Free text is fine;
  the warehouse matches codes.
- "Anbara göndər" moves the job to `BAXIS` and puts the parts list in the
  warehouse queue. After that, findings can only be added, not edited
  (corrections need a reason).

### 3.7 Work and handover actions (on the job card)
- **Start work** (`TEMIRDE`): allowed once required parts are issued.
- **Additional finding during work**: same form as 3.6; creates an
  `ELAVE_AKT` request for the warehouse. Its parts cannot be issued until
  the client approves.
- **Removed parts**: for each replaced part, the formen photographs the old
  part and records its disposition: returned to client, disposed, kept for
  warranty claim (R7).
- **Quality check** (`HAZIR`): checklist (test drive done, no warning
  lights, fluids checked, car clean) plus a dashboard photo. Sends the
  "car ready" message.
- **Handover** (`TEHVIL_VERILDI`): the Təhvil-Təslim aktı is generated and
  signed on screen by the person collecting the car (name and phone
  recorded).

---

## 4. QR stickers

- The QR encodes a URL containing only `qr_token` (random, 128-bit). No
  personal or vehicle data on the sticker (R8).
- Scanning the sticker with any other phone shows nothing without login.
- Printing needs a small label printer next to the tablet (see open
  questions). Heat- and oil-resistant labels.
- Reprinting marks the old token `REPLACED`; scanning it shows a warning.

---

## 5. Client messages (via backbone outbox)

| Event | Message (Azerbaijani template) |
| --- | --- |
| Job created | Car received, job number, link to status page |
| Qüsur aktı ready | Link to view and approve |
| Waiting for parts | Expected date if known |
| Ready | Car ready for pickup |

Sender name per D5. Email in release 1; WhatsApp after R18.

---

## 6. Edge cases

- Upload fails (weak signal): photos queue on the device and retry; the job
  cannot move past `QEBUL` until all uploads are confirmed by the server.
- Client leaves without approving: job goes to `LEGV` with reason;
  management sees the list.
- Wrong vehicle selected: the job can be annulled with reason before
  inspection; after that, only management can annul.
- Car brought without the client: complaints recorded from the driver,
  confirmation by the driver (name, phone).

---

## 7. Flagged concerns

| Risk | Handling |
| --- | --- |
| R1 | Named approvers not yet agreed; driver name and phone always recorded. |
| R2 | Evidence required on every finding; mechanic recorded on each. |
| R3 | Formen records for mechanics; old-part photos close part of the gap. |
| R9 | Odometer at entry only; comparison with history and per-day jump check. |
| R19 | Decoder chosen after testing real VINs; manual entry always available. |

---

## 8. Acceptance criteria

1. A returning car is identified by QR scan and its VIN confirmed in
   under 30 seconds.
1a. No identification, contract check or history lookup uses the plate as
   a key. Changing a car's plate keeps its full history.
2. A new car can be created from a camera-scanned VIN, with decoded fields
   prefilled where the decoder knows the VIN.
3. A job order cannot be saved without six photos, an odometer value and a
   confirmation.
4. An odometer lower than the last reading cannot be saved without a reason,
   and the owner receives a notification.
5. A corporate car not on its contract shows a warning and the choice is
   logged.
6. Every finding has a mechanic and at least one attachment.
7. After "Anbara göndər", the parts list appears in the warehouse queue
   within 5 seconds.
8. Every action on the tablet is attributed to the PIN holder.

---

## 9. Open questions

1. Label printer: is the owner fine buying one (a small thermal label
   printer)? Without it, stickers are printed in the office.
2. Does the formen assign mechanics, or do mechanics pick jobs?
3. Where on the car should the sticker go?
4. Which quality check items does the business want on the checklist?
5. Photo of the current paper intake form, to make sure no field is lost.
