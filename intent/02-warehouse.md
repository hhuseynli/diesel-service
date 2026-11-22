# Intent: Warehouse and inventory
Author: Aykhan Nazaraliyev, with Diesel Motors. Status: DRAFT, pending
owner review. Part of the first release. Builds on [[00-backbone]] and
[[01-foreman-intake]].

## Problem
The warehouseman receives the preliminary parts list on paper or by
message, looks up codes by VIN by hand, and builds the Qüsur aktı in 1C.
Part names are inconsistent (mixed Azerbaijani and Russian, no codes,
brands or units). Nothing ties a part leaving the warehouse to the car it
went into, so stock losses, swapped parts and phantom parts are hard to see.

## Proposed outcome
### Item catalog
Every part, fluid and consumable has one record: standard name, part code
(OEM and cross-references), brand, original or aftermarket, unit (piece,
set, litre, kg), purchase cost, selling price or markup rule, and
compatible vehicles where known. Services (labor) are separate catalog
items.

### From parts list to Qüsur aktı
1. The mechanic's preliminary list appears in the warehouse queue, linked
   to the job order and the car's VIN.
2. For each line the warehouseman picks a catalog item (searching by code,
   name or vehicle). Stock on hand shows next to each choice.
3. Prices come from the catalog. Any manual price change or discount needs
   a permission and a reason, and is logged.
4. The system generates the Qüsur aktı with VIN, client, job number, part
   codes, brands, units, labor lines and VAT, and sends it for client
   approval.
5. Items not in stock are marked "to order". Under the contract, parts
   ordered from abroad are ordered only after the client pays for them.

### Purchases and sales
The warehouseman records both purchases (alış) and sales (satış) of goods.
Every receipt into stock (mədaxil) and every issue out of stock (məxaric)
is pending until management approves it. Approved sales then go to the
cashier (cash) or the bookkeeper (bank transfer) to confirm payment.

Because one person buys, holds and sells stock, the system also:
- Shows management each purchase price next to that supplier's and other
  suppliers' recent prices for the same item.
- Requires a photo of the supplier's invoice with each purchase.

### Stock movements
- **Receiving**: goods arriving from a supplier are counted and recorded
  against the purchase. Differences between what was invoiced and what
  arrived are flagged.
- **Issuing**: a part leaves the warehouse only against an approved job
  order. The formen confirms which mechanic received it (the mechanic
  confirms personally once they have a tablet).
- **Returns**: unused parts return to stock against the same job order.
- **Removed old parts**: recorded as returned to the client or disposed of.
- **Write-offs** (damaged, defective, lost): require a reason, a photo and
  the owner's approval.
- **Stock counts**: periodic counts are entered without the counter seeing
  the expected quantity, so the count cannot be adjusted to match. The
  system shows the differences to the owner.

### Checks the system runs automatically
- Quantities on the approved Qüsur aktı, issued from stock, and billed to
  the client must match. Any mismatch is flagged.
- Fluids and consumables above the normal amount for that vehicle and job
  are flagged (for example, more oil than the engine's capacity).
- Low stock warnings for frequently used items.

## Affected users and systems
Warehouseman, management (approvals), cashier, bookkeeper, formen,
mechanics, clients
(receive the Qüsur aktı), 1C during the transition.

## Constraints
- The catalog starts from the business's existing stock and 1C data;
  cleaning up names, codes and units is part of this work.
- Stock valuation method (average cost or FIFO) is set with the
  accountant.
- Every stock movement is linked to a document and a person; nothing is
  deleted.

## Out of scope for this intent
Client approval flow and notifications, supplier payments and
receivables (payments intent), accounting entries, fraud analytics
beyond the automatic checks above.

## How we will know it worked
- Time from parts list to a finished Qüsur aktı, before and after.
- Difference between counted and system stock at each count, falling over
  time.
- Every part issued is traceable to a car and an approved document.

## Open questions
1. Does stock move from 1C to the new system at the first release, or does
   1C keep it until the accounting modules are ready?
2. How are selling prices set today: fixed list, markup on cost, or case by
   case?
3. Which parts catalogs or suppliers' price lists does the warehouseman use
   to find codes by VIN?
4. How often is stock counted today, and by whom?
5. Is there one warehouse location or several storage areas?
6. Roughly how many different items are in stock?
