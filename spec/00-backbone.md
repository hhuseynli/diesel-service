# Spec: System backbone
From intent: intent/00-backbone.md (DRAFT v2). Status: DRAFT for review.
Author: Aykhan Nazaraliyev, with Claude. Risk IDs refer to RISKS.md.

This spec defines what every module shares: the data model core, the job
order lifecycle, roles and permissions, approvals, audit, document
numbering, files, notifications and technical foundations. Module specs
(formen intake, warehouse, and later ones) add their own tables and screens
on top and must not redefine anything here.

---

## 1. Decisions needed before building

| ID | Decision | Proposal | Who decides |
| --- | --- | --- | --- |
| D1 | Tech stack | TypeScript end to end: Next.js (web app, installable on the tablet as a PWA) + PostgreSQL. One language for Claude Code to work in, strong typing for money and states, Postgres for transactions and database-level protections. Alternative: Django + PostgreSQL if you prefer Python. | Aykhan |
| D2 | Hosting region | A cloud provider with a region acceptable under local personal data rules (R20). | Aykhan + owner |
| D3 | Approval mode for stock issues | One of the R10 options; the approval engine supports all three. | Owner |
| D4 | VAT rounding | Document-total method (as on paper) until the accountant confirms (R16). | Accountant |
| D5 | Sender name on client messages | Diesel Motors or Highest Service (R23). | Owner |

---

## 2. Conventions

- Money: `NUMERIC(14,2)` in AZN. Never floating point.
- Quantities: `NUMERIC(12,3)` with an explicit unit.
- VAT: rate stored in a settings table with an effective-from date
  (currently 18%). Documents store the rate they used.
- Time: all timestamps set by the database (`now()`), stored in UTC, shown
  in Asia/Baku. Clients never send timestamps for recorded events.
- IDs: UUIDs internally. Human-readable numbers only on documents (section 7).
- Vehicles are identified only by VIN. Plates change, so no table, check or
  lookup uses a plate as a key; plates are stored as dated history (R25).
- UI language: Azerbaijani. All strings live in translation files from day
  one, even with one language, so Russian can be added without code changes.
- The legal entity is Highest Service MMC. Its details (name, VOEN, address,
  bank) live in a settings record and print on every document. The Diesel
  Motors brand appears only where marketing settings say so.

---

## 3. Data model (core tables)

Field lists show what matters for review, not every column. Every table
also has `created_at`, `created_by`.

### People and access
| Table | Key fields | Notes |
| --- | --- | --- |
| `users` | full_name, phone, email, pin_hash, is_active | Staff accounts. Never deleted, only deactivated. |
| `user_roles` | user_id, role | A user can hold several roles. |
| `client_portal_users` | contragent_id, full_name, phone, email | Corporate approvers. Linked to a contract in `contract_approvers`. |

### Contragents and contracts
| Table | Key fields | Notes |
| --- | --- | --- |
| `contragents` | kind (fiziki/huquqi), name, voen, phone, email, address, bank_details, is_customer, is_supplier | One record can be customer and supplier. |
| `contracts` | contragent_id, number, signed_on, valid_from, valid_to, auto_renew, deferred_payment_days, advance_threshold_ex_vat, advance_percent, penalty_rate_daily, penalty_cap_percent, status | Penalty fields are used only by the on-request calculation (R17). |
| `contract_vehicles` | contract_id, vehicle_id, added_on, removed_on | The list the intake check uses. Matched by VIN; the plate written in the contract is kept for reference only. |
| `contract_approvers` | contract_id, client_portal_user_id, max_amount (optional) | Named people allowed to approve (R1). |

### Vehicles
| Table | Key fields | Notes |
| --- | --- | --- |
| `vehicles` | vin (unique, 17 chars, validated), make, model, year, engine, qr_token (unique, random), decode_source | `qr_token` is what the sticker encodes (R8). |
| `vehicle_plates` | vehicle_id, plate_normalized, plate_display, valid_from, valid_to, status, source | Display and search only, never identity. Full rules in section 3a. |
| `odometer_readings` | vehicle_id, job_order_id, value_km, photo_id | Compared with previous readings (flag if lower). |

### Job orders
| Table | Key fields | Notes |
| --- | --- | --- |
| `job_orders` | number, vehicle_id, contragent_id, contract_id, status, formen_id, mechanic_id, complaints, opened_at | The spine. Every module links here. |
| `job_status_events` | job_order_id, from_status, to_status, user_id, reason | Every transition recorded (section 4). |

### Catalog
| Table | Key fields | Notes |
| --- | --- | --- |
| `items` | code, name, brand, kind (part/fluid/consumable/service), origin (OEM/aftermarket), unit, vat_rate, is_active | Detailed in the warehouse spec. |

### Documents (one shared structure for all document types)
| Table | Key fields | Notes |
| --- | --- | --- |
| `documents` | type, number, status, doc_date, job_order_id, contragent_id, vin_snapshot, plate_snapshot, total_ex_vat, vat_amount, total, version, supersedes_id | Header for every document type. |
| `document_lines` | document_id, item_id, quantity, unit, unit_price, discount, discount_reason, vat_rate, line_total | |
| `approvals` | document_id, step_no, required_role, status, decided_by, decided_at, comment | Section 6. |
| `payments` | document_id, method (cash/transfer/card), amount, received_on, confirmed_by, confirmed_role | Card enabled later. |

Document types in release 1: `QUSUR_AKTI`, `ELAVE_AKT` (supplementary
estimate), `QIYMET_PROTOKOLU`, `TEHVIL_TESLIM`, `SATIS` (sale),
`ALIS` (purchase), `MEDAXIL` (stock receipt), `MEXARIC` (stock issue),
`SILINME` (write-off), `INVENTAR` (stock count).

### Cross-cutting
| Table | Key fields | Notes |
| --- | --- | --- |
| `attachments` | storage_key, sha256, mime_type, linked_table, linked_id | Photos and scans. Immutable (section 8). |
| `audit_log` | table_name, record_id, action, before, after, user_id, reason, at | Append-only (section 5). |
| `notification_outbox` | channel, recipient, template, payload, status, attempts | Section 9. |
| `document_counters` | doc_type, year, last_number | Section 7. |
| `settings` | key, value, effective_from | Company details, VAT rate, approval rules. |

The accounting ledger (`accounts`, `journal_entries`, `journal_lines`) is
defined in the accounting spec. The tables above are designed so every
financial document can later post entries without schema changes.

---

## 3a. Vehicle identity and plate changes

Plate changes are routine (re-registration, sale of the car, personalized
plates, plates moved from one car to another). The system treats them as
normal events, not errors (R25).

### Rules
1. A vehicle is its VIN. Its plate is an attribute that changes over time.
2. `vehicle_plates` keeps every plate a vehicle has had:

   | Field | Meaning |
   | --- | --- |
   | vehicle_id | The car |
   | plate_normalized | Uppercase, spaces and hyphens removed ("90-JG-526" → "90JG526"); used for search |
   | plate_display | As written on the plate |
   | valid_from, valid_to | When this plate was seen on this car; `valid_to` empty while current |
   | status | ACTIVE, ENDED, UNCONFIRMED |
   | source | INTAKE, CONTRACT, IMPORT |
   | recorded_by, job_order_id | Who recorded it and on which visit |

3. Database constraints: at most one ACTIVE plate per vehicle, and at most
   one ACTIVE vehicle per normalized plate. The plate field is optional:
   new cars without plates and transit plates are allowed. Foreign plates
   are accepted without format checks.
4. Recording a new plate for a car ends its previous plate (`valid_to` =
   today) in the same transaction. Nothing is deleted or overwritten.
5. If the new plate is currently ACTIVE on another vehicle, that other
   record is set to UNCONFIRMED (its owner probably changed plates without
   us knowing) and the formen sees a notice. The other car's history is not
   touched.
6. Every plate change writes an audit row and is visible on the vehicle's
   timeline.

### Documents keep the plate they were issued with
- `documents` and `job_orders` store `vin_snapshot` and `plate_snapshot`,
  copied when the document is numbered.
- Printed and re-printed documents always show the snapshot. A Qüsur aktı
  from last year shows last year's plate, matching what the client signed
  and what was sent in the e-qaimə.

### Search
- Search by plate matches current and former plates. Results show "former
  plate, used until <date>" for ended plates and always lead to a VIN.
- The job board and lists show the current plate plus the last 6 VIN
  characters.

### Plate change and change of owner
A new plate often means the car was sold.
- At intake, if the client differs from the last visit, the formen is asked
  whether ownership changed. If yes, the new owner is linked from this
  visit on.
- Clients and corporate approvers see only the visits made under their own
  name or contract. A new owner never sees the previous owner's visits,
  invoices or contact details. Staff see the full history by VIN.
- A car sold by a corporate client is removed from that contract
  (`contract_vehicles.removed_on`) by the warehouseman or management, with
  a note.

### Contracts and imports
- Vehicle lists from contracts are imported by VIN. Plates in the list are
  recorded with source CONTRACT. A contract listing a car under an old
  plate needs no amendment.
- A contract vehicle list without VINs is rejected at import, with the
  missing rows listed.

## 4. Job order lifecycle

| Status | Entered when | Who triggers |
| --- | --- | --- |
| `QEBUL` (received) | Intake saved with required photos | Formen |
| `BAXIS` (inspected) | Findings and parts list submitted | Formen (for mechanic) |
| `QIYMETLENDIRME` (estimating) | Warehouse starts the Qüsur aktı | Warehouseman |
| `TESDIQ_GOZLEYIR` (awaiting client) | Qüsur aktı sent to client | Warehouseman |
| `TESDIQLENDI` (approved) | Client or named approver approves | Client |
| `HISSE_GOZLEYIR` (waiting for parts) | Approved items are not in stock | System |
| `TEMIRDE` (in service) | Parts issued, work started | Formen |
| `HAZIR` (ready) | Quality check passed | Formen |
| `TEHVIL_VERILDI` (handed over) | Təhvil-Təslim aktı signed | Formen |
| `ODENILDI` (paid) | All payments confirmed | System |
| `BAGLANDI` (closed) | Paid and handed over | System |
| `LEGV` (cancelled) | Client declines or leaves | Formen, with reason, management sees it |

Rules:
- Only the transitions in this table are allowed; anything else is refused
  by the server.
- A supplementary estimate (`ELAVE_AKT`) can be opened from `TEMIRDE`. Its
  items cannot be issued or billed until the client approves it. Payment for
  it is taken after the service.
- `TEHVIL_VERILDI` may come before `ODENILDI` for clients with deferred
  payment terms.

---

## 5. Audit rules (enforced in the database, not only in code)

1. `audit_log` is append-only. The application's database user has no
   UPDATE or DELETE permission on it.
2. Every insert or update on business tables writes an audit row with the
   before and after values, the user and, for corrections, a mandatory
   reason.
3. Documents in status `APPROVED` or `POSTED` cannot be updated. A database
   trigger rejects the change. Corrections create a new version
   (`supersedes_id`) or a reversing document.
4. No business record is deleted. Cancelling sets status `ANNULLED` with a
   reason.
5. Discounts and price changes after estimation require the
   `change_price` permission and a reason, and appear in a separate owner
   report (R5).

---

## 6. Approvals

One approval engine serves every document type. Rules live in `settings`
so they can change without code.

| Document | Steps (release 1) |
| --- | --- |
| `QUSUR_AKTI`, `ELAVE_AKT` | 1. Client: individual by one-time code via WhatsApp/email; corporate by a named approver (R1) |
| `MEDAXIL` | 1. Management |
| `MEXARIC` | 1. Management, using the mode chosen in D3 |
| `SILINME` | 1. Management (photo and reason required) |
| `SATIS` | 1. Management. 2. Cashier if paid in cash, bookkeeper if by transfer |
| `ALIS` | 1. Management |

- A document cannot be approved by the user who created it.
- Rejection requires a comment and returns the document to its creator.
- Management sees a single queue of everything waiting, oldest first, on
  the phone.

---

## 7. Document numbering

- Format: `<PREFIX>-<YEAR>-<6-digit sequence>`, for example
  `QA-2026-000123`.
- Numbers are gapless per type per year. They are assigned in the same
  transaction that submits the document, using a row lock on
  `document_counters` (database sequences can skip numbers, so they are not
  used here).
- Drafts have no number. Once numbered, a document can be annulled but its
  number is never reused.

---

## 8. Files and photos

- Stored in cloud object storage; the database keeps the key and a SHA-256
  hash.
- Files are never overwritten or deleted. The hash lets anyone prove a
  photo has not been altered since upload.
- Photos are taken in the app with the camera, not picked from the gallery,
  for evidence photos (odometer, findings, invoices).

---

## 9. Notifications

- Written to `notification_outbox` in the same transaction as the event
  that triggers them, then sent by a background worker with retries.
- Channels: email in release 1; WhatsApp through a provider once R18 is
  decided. Adding a channel means adding one adapter.
- Templates in Azerbaijani, sender name per D5.

---

## 10. Authentication and the shared tablet

- Every person has their own account, including on the shared tablet (R11).
- On the tablet, a user switches in with a personal PIN; the session locks
  after 5 minutes without activity.
- Office users log in with phone and password, with a second factor for
  management and the owner.
- Clients approve through a link plus a one-time code; corporate approvers
  have portal accounts.

### Permission matrix (release 1)
| Action | Owner | Management | Formen | Warehouseman | Cashier | Bookkeeper |
| --- | --- | --- | --- | --- | --- | --- |
| Create job order, intake, inspection | yes | | yes | | | |
| Create Qüsur aktı, purchases, sales, stock documents | yes | | | yes | | |
| Approve stock and sales documents | yes | yes | | | | |
| Confirm cash payment | yes | | | | yes | |
| Confirm transfer payment | yes | | | | | yes |
| Change price or discount | yes | yes | | with reason | | |
| See financial statements and analytics | yes | | | | | |
| Manage users and settings | yes | | | | | |

The mechanic role exists but has no permissions until tablets arrive (R3).

---

## 11. Non-functional requirements

- Tablet-first interface: large touch targets, works in portrait on a
  10-inch tablet and on phones.
- Camera access in the browser for QR, VIN and photos.
- Daily backups with point-in-time recovery; a restore is tested before
  go-live.
- HTTPS everywhere; staff accounts locked after repeated wrong PINs.

---

## 12. Flagged concerns

| Concern | Effect on this spec |
| --- | --- |
| R1 named approvers not yet agreed | `contract_approvers` built; if the owner declines, approval falls back to the person bringing the car, recorded by name and phone. |
| R10 approval bottleneck | Engine supports all three modes; D3 picks one. |
| R12, R13 accounting compliance | Ledger left to the accounting spec; nothing here assumes a chart of accounts. |
| R14 stock in two systems | If stock stays in 1C at release 1, `MEDAXIL`/`MEXARIC` run without valuation until cut-over. |
| R16 VAT rounding | Calculation isolated in one function so the method can change. |

---

## 13. Acceptance criteria

1. A car can go from `QEBUL` to `BAGLANDI` in the system with every
   document generated and numbered, and no paper.
2. Trying to edit an approved document, or delete any record, fails at the
   database level, and the attempt is logged.
3. A document cannot be approved by its creator.
4. Document numbers have no gaps after creating, annulling and approving
   documents in any order.
5. Every action on the shared tablet is attributed to the person who
   unlocked it.
6. A notification is sent within one minute of the triggering event, and
   retried if the channel fails.
7. Changing a car's plate keeps its full history; old documents still
   print the plate they were issued with.
8. Searching a former plate finds the car and labels the plate as former.
9. Assigning a plate that is active on another car succeeds, marks the
   other record UNCONFIRMED, and shows a notice.
10. A new owner's client portal shows none of the previous owner's visits.

## 14. Out of scope
Module screens and rules (in their own specs), the ledger and financial
statements, analytics, fraud analytics, data migration from 1C.
