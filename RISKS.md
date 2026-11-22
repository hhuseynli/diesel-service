# Risks and concerns register
Project: Highest Service MMC operations and accounting system (brand: Diesel Motors)
Maintained by: Aykhan Nazaraliyev. Last updated: 2026-11-22 (R25 added).

Status values: OPEN (needs a decision), MITIGATED (handled in an intent or
spec), ACCEPTED (owner chose to live with it), CLOSED (no longer applies).
Specs reference these IDs when they touch a risk.

---

## Fraud and internal control

### R1. Driver counts as the corporate client's representative
Contract clause 1.3 says whoever brings the car is the client's authorized
representative. A driver can approve an inflated Qüsur aktı on the company's
account, or get work on a personal car billed to the company, and split the
difference with staff.
- Mitigation: named approvers per corporate client, who log in to approve.
  Requires changing the contract template.
- Status: OPEN. Decision: owner.

### R2. Mechanic diagnoses and earns a percentage of the repair
The mechanic does the inspection and is paid salary plus a percentage, so
the person deciding what is broken earns more when more is replaced.
- Mitigation: photo or video evidence for every finding; formen review
  before findings reach the warehouse; later, analytics comparing each
  mechanic's recommendation value with the shop average.
- Status: MITIGATED in part (evidence required in 01-foreman-intake).
  Analytics pending.

### R3. Mechanics have no login yet
The formen records mechanics' work on one shared tablet, so mechanics never
personally confirm the parts they received or installed.
- Mitigation: formen names the mechanic on every action; photos of
  installed and removed parts; mechanic role exists from the start and is
  switched on when tablets arrive.
- Status: MITIGATED in part. Revisit when tablets are bought.

### R4. One person buys, holds and sells stock
The warehouseman records purchases and sales and controls the stock.
Risks: overpriced purchases from a friendly supplier, fake purchases,
selling stock on the side.
- Mitigation: management approves every mədaxil and məxaric; purchase price
  shown next to recent supplier prices; supplier invoice photo required;
  blind stock counts.
- Status: MITIGATED in 02-warehouse, subject to R10.

### R5. Prices and discounts changed after estimation
The old Qüsur aktı has a second "Ödəniləcək məbləğ" column where amounts can
quietly differ from the calculated ones.
- Mitigation: price change or discount needs a permission and a reason,
  logged separately and visible to the owner.
- Status: MITIGATED in 00-backbone.

### R6. Unrecorded cash and off-the-books work
Jobs paid in cash may never be entered, or entered at a lower amount.
Mechanics may do work outside the system.
- Mitigation: every car gets a job order at intake with photos; cash is
  confirmed by the cashier against an approved sales document; later,
  analytics on cars entering versus invoices issued.
- Status: MITIGATED in part.

### R7. Part swapping, phantom parts, fluid overbilling, old parts disappearing
- Mitigation: parts issued only against an approved job order; automatic
  matching of estimated, issued and billed quantities; fluid quantities
  checked against normal amounts; disposition of removed parts recorded.
- Status: MITIGATED in 02-warehouse.

### R8. QR sticker swapped or lost
A sticker moved to another car could pull up the wrong history.
- Mitigation: QR holds only a random ID; the VIN is always confirmed
  against the car; a lost sticker is reprinted from the VIN.
- Status: MITIGATED in 01-foreman-intake.

### R9. Car used while at the shop
The odometer is recorded only at entry (owner's choice), so use of the car
during its stay is not detected until the next visit, if ever.
- Mitigation: none beyond comparison at the next visit. Recording the exit
  odometer would close this gap at the cost of one photo.
- Status: ACCEPTED by owner. Worth raising again later.

### R25. License plates change
Plates are transferred, replaced or re-registered, so a plate cannot
identify a car. A plate moved to another car could attach the wrong
history or contract to a job.
- Mitigation: every vehicle is identified only by VIN. Plates are stored
  as dated history for display and search; a plate search that matches a
  different VIN than before warns the formen.
- Status: MITIGATED. Full handling in spec/00-backbone.md section 3a.

---

## Process

### R10. Approval bottleneck
Management approves every mədaxil and məxaric. If approval waits, cars wait
for parts, which recreates the delay the system is meant to remove.
- Options: one-tap approval on the phone; one batch approval for all parts
  on a Qüsur aktı the client already approved; automatic approval below an
  amount, still visible to management.
- Status: OPEN. Decision: owner.

### R11. Shared tablet blurs who did what
If everyone uses one login on the shared tablet, the audit log records the
wrong person.
- Mitigation: personal login with quick PIN switching and auto-lock after
  inactivity.
- Status: MITIGATED in spec/00-backbone.

---

## Accounting and compliance

### R12. Replacing 1C means meeting Azerbaijani tax and accounting rules
Chart of accounts, VAT, e-qaimə and statutory reports must be correct.
Mistakes carry legal and financial risk.
- Mitigation: accountant reviews requirements before accounting specs;
  parallel run with 1C until a full period closes with matching results.
- Status: OPEN. Depends on R13.

### R13. No accountant identified yet
- Status: OPEN. Decision: owner.

### R14. Stock in two systems during the first release
If the new warehouse runs while 1C still holds stock, the two will drift.
- Status: OPEN. Decision: owner with accountant.

### R15. Dirty data from 1C
Item names mix Azerbaijani and Russian, codes and units are missing. The
catalog cleanup is real work and can delay the first release.
- Mitigation: migrate and clean the most used items first; flag the rest.
- Status: OPEN. Sized during the warehouse spec.

### R16. VAT rounding method
The paper Qüsur aktı applies 18% VAT to the document total. Line-level
calculation can give different cents. The method must match the e-qaimə.
- Status: OPEN. Decision: accountant.

### R17. Contract late penalty
The 0.1% per day penalty (capped at 10%) is charged only through court.
- Mitigation: system tracks overdue days and calculates the penalty on
  request, never on invoices.
- Status: MITIGATED in 00-backbone.

---

## Technical and vendor

### R18. WhatsApp Business messaging costs and approval
Sending WhatsApp messages from a system requires an approved provider and
per-message fees.
- Mitigation: email works from day one; WhatsApp added through a provider
  once costs are agreed.
- Status: OPEN. Decision: owner (budget).

### R19. VIN decoding may be unreliable for local vehicles
Free decoders cover US-market cars well; Baku has cars and commercial
trucks from many markets.
- Mitigation: test 20 to 30 real VINs before choosing a service; manual
  entry always possible.
- Status: OPEN.

### R20. Client personal data in the cloud
Names, phones, VOEN and vehicle data will be stored with a cloud provider.
Azerbaijani personal data rules may restrict where it can be hosted.
- Mitigation: check requirements before choosing the hosting region.
- Status: OPEN.

### R21. Data model changes are expensive later
Screens are cheap to rewrite with AI; changing how stored data is
structured after real use is slow and risky.
- Mitigation: careful backbone spec reviewed before building.
- Status: MITIGATED by process.

---

## Project

### R22. No named approver on the client side
Intents and specs need someone at the business to accept them.
- Status: OPEN. Decision: owner.

### R23. Brand versus legal entity in client messages
Documents are Highest Service MMC; marketing is Diesel Motors. Client
messages (WhatsApp, email) need one sender name.
- Status: OPEN. Decision: owner.

### R24. Scope size
Replacing 1C makes this a large system built by a very small team.
- Mitigation: first release limited to formen and warehouse; accounting
  modules follow in later releases.
- Status: MITIGATED by release plan.
