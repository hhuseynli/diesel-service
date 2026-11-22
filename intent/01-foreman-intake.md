# Intent: Vehicle intake, inspection and job order (formen)
Author: Aykhan Nazaraliyev, with Diesel Motors. Status: DRAFT v2 (owner
answers applied). Part of the first release. Builds on [[00-backbone]].

## Problem
When a car arrives, the formen writes vehicle and client details on paper.
Complaints, inspection results and the list of services and parts move
through paper, verbal messages and WhatsApp. Intake is slow, information is
lost between people, the car's condition at entry is not reliably recorded,
and clients do not know their car was received or what happens next.

## Proposed outcome
The formen opens a digital job order on a phone or tablet when the car
arrives. Every later step attaches to it.

### Intake (formen)
1. Scans the car's QR sticker. A returning car's details (make, model, year,
   VIN, owner, history) load instantly. The formen confirms the VIN on
   screen matches the car (the plate may have changed; a new plate is
   simply recorded).
2. A car without a sticker: the formen scans the VIN with the camera or
   types it. The system decodes make, model, year and engine from the VIN
   where possible, then prints a QR sticker that the formen attaches.
3. For corporate clients, the VIN is checked against the contract; a car not on the contract triggers a warning.
4. Records client type (fiziki / hüquqi şəxs), name, VOEN, phone, email.
5. Required photos: odometer, four sides of the car, dashboard warning
   lights. The odometer value is entered and compared with previous visits;
   a lower reading or an unusual jump raises a flag to the owner.
6. Records the client's complaints in the client's own words.
7. The client confirms the intake on screen or by a code sent to them.

Entry date and time are recorded by the system and cannot be edited, nor
can the photos.

### Inspection (mechanic, recorded by the formen)
The job is assigned to a mechanic, who inspects the car. For now there is
one shared tablet and mechanics have no login, so the formen records on
the same job order, naming the mechanic:
- Findings, each with at least one photo or short video as evidence.
- Services to perform.
- A preliminary list of parts and products, in plain description.

The formen reviews the findings and sends them on. The parts list arrives
in the warehouse queue automatically.

### Client notification
The client gets a WhatsApp and email message confirming the car was
received, with the job number. A status change (estimate ready, waiting for
parts, ready for pickup) sends a new message.

## Affected users and systems
Formen (one today, more later), mechanics (named on each job, own login
later), warehouseman (receives the parts list), clients, owner.

## Constraints
- Fast in a workshop: large buttons, minimal typing. One shared tablet
  today; one tablet per mechanic later, so screens must work for both.
- Documents carry Highest Service MMC details.
- Azerbaijani interface.
- QR codes hold only an ID, never data. A sticker alone never identifies a
  car; the VIN is always confirmed against the car. Plates are never used
  to identify a vehicle, only displayed (R25).
- VIN decoding must be tested on 20 to 30 real VINs from the business's
  records before a decoding service is chosen.

## Out of scope for this intent
Part code lookup and stock (warehouse intent), estimate pricing, client
approval, servicing, payment, fraud analytics.

## How we will know it worked
- No paper intake forms.
- Intake time per car, measured before and after.
- Share of job orders with all required photos.
- Time from inspection finished to the parts list reaching the warehouse.

## Open questions
1. Does the formen assign the mechanic, or do mechanics pick jobs?
2. Where on the car should the QR sticker go?
3. A photo of the current paper intake form.
