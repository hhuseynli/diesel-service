# Spec: Warehouse, estimates and stock
From intent: intent/02-warehouse.md (DRAFT). Builds on spec/00-backbone.md
and spec/01-foreman-intake.md. Status: DRAFT for review. Risk IDs refer to
RISKS.md.

Assumes D1 (TypeScript, Next.js, PostgreSQL). The warehouseman works on an
office computer; management approves on a phone.

---

## 1. Principles

- **Stock is never typed in.** Stock on hand is always the sum of stock
  movements. No screen lets anyone set a quantity directly.
- **Every movement has a document and a person.** No document, no movement.
- **Every movement waits for management** (backbone section 6), in the mode
  chosen for D3 (R10).

---

## 2. Additional tables

| Table | Key fields | Notes |
| --- | --- | --- |
| `item_codes` | item_id, code, code_type (OEM, SUPPLIER, CROSS_REF) | One item, many codes; search uses all. |
| `item_fits` | item_id, make, model, engine, year_from, year_to | Optional; improves search by vehicle. |
| `price_rules` | scope (item, brand, kind), markup_percent or fixed_price, effective_from | Section 5. |
| `stock_locations` | name | One location in release 1. |
| `stock_moves` | item_id, location_id, quantity (+ in, - out), unit_cost, document_id, job_order_id | The only source of stock levels. Written only when a document is approved. |
| `stock_reservations` | item_id, job_order_id, quantity, status | Reserved for an approved estimate, not yet issued. |
| `supplier_prices` | supplier_id, item_id, unit_price, date, document_id | Filled from approved purchases. Feeds the price comparison (R4). |
| `fluid_norms` | item_kind or item_id, make, model, engine, max_quantity | For overbilling checks (R7). Filled over time. |
| `min_stock` | item_id, min_quantity | Low stock warnings. |

---

## 3. Screens

### 3.1 Warehouse queue
- Lists job orders in `BAXIS` and new `ELAVE_AKT` requests, oldest first,
  with vehicle (VIN, make, model, engine), current plate and time waiting.

### 3.2 Build the Qüsur aktı
Left: the formen's parts requests and planned services as written. Right:
catalog search, filtered by the vehicle when `item_fits` data exists.
1. For each request, pick a catalog item. Each result shows code, brand,
   OEM or aftermarket, unit, stock on hand, reserved quantity and price.
2. No match in the catalog → "Yeni mal" form (name, code, brand, origin,
   unit). New items are marked `UNVERIFIED` until management approves them.
3. Add labor lines from catalog services (pricing method pending, see open
   questions).
4. Price comes from `price_rules`. Changing it or adding a discount needs a
   reason and the `change_price` permission (R5).
5. Items short in stock are marked "sifariş olunacaq". If a part is ordered
   from abroad, the line is marked prepayment required (contract 4.5).
6. "Müştəriyə göndər" numbers the document, generates the printable aktı,
   moves the job to `TESDIQ_GOZLEYIR` and sends the approval message.

### 3.3 Printed Qüsur aktı (PDF)
Highest Service MMC header and details; document number and date; job
number; client name and VOEN; vehicle make, model, VIN, plate; odometer at
entry; table with code, name, brand, origin, unit, quantity, price, amount;
labor lines separately; total, VAT, grand total; the note about additional
work being billed separately; approval block showing who approved, when and
how (code or signature). Replaces the old layout, which lacked VIN, client,
odometer, codes, units and client approval.

### 3.4 After client approval
- In-stock items are reserved automatically.
- Short items go to the purchase list.
- The job moves to `TESDIQLENDI`, or `HISSE_GOZLEYIR` if anything is short.

### 3.5 Issue parts (MEXARIC)
- From the job order: issue reserved items, choosing the receiving
  mechanic (recorded by the formen at handover to the workshop, R3).
- Quantity issued cannot exceed the approved quantity for that job.
- Goes to management approval per D3. On approval, stock moves are
  written and reservations released.
- Unused parts come back with a return document linked to the same job.

### 3.6 Purchases (ALIS) and receiving (MEDAXIL)
1. The warehouseman creates the purchase: supplier, supplier invoice number
   and date, lines, and a photo of the supplier's invoice (required).
2. The management approval screen shows, for each line, this price beside
   the last three prices from this supplier and the lowest recent price
   from any supplier, with differences above 10% highlighted (R4).
3. When goods arrive, the warehouseman counts them and records the received
   quantities. Differences from the invoice are flagged on the document.
4. Management approves the MEDAXIL; only then do stock moves appear.

### 3.7 Sales (SATIS)
- Generated from the job order at handover: all approved lines from the
  Qüsur aktı and any approved ELAVE_AKT.
- Three-way check before it can be submitted: approved quantity = issued
  quantity = billed quantity, per item. Mismatches block submission until
  explained (R7).
- Approval chain from backbone: management, then cashier (cash) or
  bookkeeper (transfer).

### 3.8 Write-offs (SILINME)
- Item, quantity, reason (damaged, defective, lost, expired), photo
  required, management approval.

### 3.9 Stock count (INVENTAR)
- Management starts a count for all items or a selection.
- The counter sees item names and locations but not expected quantities
  (blind count, R4).
- Differences are shown only to management after submission. Adjustments
  post as an approved document with a reason.

---

## 4. Automatic checks and alerts (to management)

| Check | Trigger |
| --- | --- |
| Three-way mismatch | Approved, issued and billed quantities differ on a job |
| Fluid above norm | Quantity of a fluid on a job exceeds `fluid_norms` for that vehicle |
| Purchase price jump | Line price more than 10% above the supplier's last price |
| Invoice vs received | Received quantity differs from the supplier invoice |
| Frequent write-offs | More than a set number of write-offs per month for one item |
| Low stock | Stock below `min_stock` |
| Unverified items | New catalog items waiting for approval |

---

## 5. Pricing and valuation

- Selling price: from `price_rules` (fixed price per item, or markup on
  cost by item, brand or kind). The most specific rule wins.
- Cost of stock: weighted average cost, stored on each stock move, until
  the accountant confirms the method (R12). Isolated in one module so it
  can change to FIFO.
- VAT: per backbone D4 (R16).

---

## 6. Catalog migration from 1C

1. Export items and current balances from 1C (CSV or Excel).
2. Import into a staging table; nothing goes live yet.
3. Cleanup screen: merge duplicates, standardize names, set brand, origin
   and unit. The most used items first (by 1C sales in the last 12 months).
4. Approved items go live; opening balances are posted as one MEDAXIL per
   cut-over date, approved by management.
5. If stock stays in 1C during release 1 (R14), the catalog still migrates,
   but stock levels are shown as "not tracked" and checks that need stock
   are off.

---

## 7. Flagged concerns

| Risk | Handling |
| --- | --- |
| R4 | Management approval, price comparison, invoice photo, blind counts. |
| R5 | Price changes need permission and reason; separate owner report. |
| R7 | Three-way match, fluid norms, old-part disposition (formen spec). |
| R10 | Issue approval in the D3 mode; this spec works with all three. |
| R14 | "Stock not tracked" mode if 1C keeps stock at release 1. |
| R15 | Staged import with cleanup before items go live. |

---

## 8. Acceptance criteria

1. A Qüsur aktı for a 15-line job can be built from the formen's list in
   under 10 minutes by the warehouseman.
2. The printed aktı contains VIN, client, job number, odometer, codes,
   brands, units, labor lines, VAT and the approval record.
3. No screen can change a stock quantity directly; stock equals the sum of
   approved movements at all times.
4. A part cannot be issued beyond the approved quantity for its job.
5. A sale cannot be submitted while the three-way check fails.
6. Purchase approval shows the price comparison for every line.
7. The counter never sees expected quantities during a stock count.

---

## 9. Open questions

1. Does stock leave 1C at release 1 (R14)?
2. How is labor priced: fixed price per job, hourly, or norm hours?
3. How are selling prices set today: fixed list, markup, or case by case?
4. Do they sell parts over the counter, without a car in service?
5. Which catalogs or price lists does the warehouseman use to find codes?
6. Roughly how many items are in stock, and how often is it counted?
