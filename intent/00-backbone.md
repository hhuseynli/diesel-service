# Intent: System backbone (shared core)
Author: Aykhan Nazaraliyev, with Diesel Motors. Status: DRAFT v2 (owner answers applied), pending
accountant review.

## Problem
Diesel Motors runs on paper forms, WhatsApp messages and 1C. Data is entered
several times by different people, documents are signed in multiple paper
copies to prevent theft, and nothing connects a car's intake to its parts,
its invoice, its payment and the accounts. The business has decided to
replace 1C entirely, so the new system must become both the operational
system and the accounting system of record.

## Proposed outcome
One system where every business event is recorded once, by the person
responsible for it, and automatically flows into documents, stock, the
accounts and the owner's analytics.

The backbone defines only what every module shares. Each module (intake,
warehouse, sales and purchases, client communication, accounting reports,
analytics, fraud detection) gets its own intent and builds on this core.

### Core records
- **Legal entity**: Highest Service MMC. All official and unofficial
  documents are issued in its name. Diesel Motors MMC is the brand used for
  marketing and the website only; it keeps no books in this system.
- **Contragent**: any external party: individual client (fiziki şəxs),
  corporate client (hüquqi şəxs), supplier. One contragent can be both a
  debtor and a creditor. Stores VOEN, contacts, bank details, payment terms.
- **Contract**: belongs to a contragent. Holds payment terms (for example
  deferred payment within 15 business days, 50% advance above a threshold),
  validity and auto-renewal, the list of vehicles (by VIN) it covers,
  and the people authorized to approve work on the client's behalf. The
  contract's late penalty (0.1% per day, capped at 10%) is charged only
  through a legal claim, so the system tracks overdue days and calculates
  the penalty on request; it never adds it to an invoice automatically.
- **Vehicle**: identified only by VIN, because plates change. Make, model,
  year, engine, plate history for display; full service history
  across visits.
- **Job order**: the spine of the system. Created at intake; every later
  document, part movement and payment for that visit attaches to it.
- **Item catalog**: parts, fluids and consumables with a standard name,
  part code, brand, unit of measure (piece, set, litre) and type (original
  or aftermarket). Services (labor) are separate catalog items.
- **Ledger**: double-entry accounting. Every financial event (sale,
  purchase, payment, stock issue, depreciation) posts balanced journal
  entries. Financial statements are always generated from the ledger,
  never typed in.

### Job order lifecycle
received → inspected → estimated (Qüsur aktı) → approved by client →
waiting for parts (optional) → in service → quality checked → handed over
(Təhvil-Təslim aktı) → invoiced (e-qaimə) → paid → closed.

Additional work found during service creates a supplementary estimate that
needs its own client approval before it can be billed. Additional parts and
work are paid after the service is done.

### Approval flow for sales
warehouseman prepares the sales document → management approves →
cash payment goes to the cashier for confirmation, bank transfer goes to
the bookkeeper for confirmation.

### Documents the system produces
Qüsur aktı, Qiymətlərin Razılaşdırma Protokolu, Təhvil-Təslim aktı,
hesab-faktura, e-qaimə data, purchase records, payment receipts. Each has a
sequential number that cannot be reused or skipped.

### Roles and permissions
- **Superadmin (owner)**: sees everything, including financial statements
  and analytics; manages users and settings.
- **Foreman**: intake, inspection results, service and preliminary parts
  lists.
- **Management (rəhbərlik)**: approves every warehouse receipt (mədaxil)
  and issue (məxaric) and every sales document.
- **Warehouseman**: purchases (alış) and sales (satış) of goods, part codes,
  stock, estimates. Every mədaxil and məxaric waits for management approval.
- **Cashier (kassa)**: confirms cash payments on approved sales.
- **Bookkeeper**: confirms bank transfer payments on approved sales; does
  not see financial statements or analytics.
- **Mechanic**: performs the technical inspection and the repair, but has
  no login yet: the formen records their work on one shared tablet. The
  role exists in the system from the start and is switched on when each
  mechanic gets a tablet. Paid salary plus a percentage, so their
  recommendations must be reviewable.
- **Corporate client approver**: a named person at a corporate client; logs
  in to approve estimates and see their vehicles' service history.
- Cashier: to be confirmed.

### Audit rules (apply to every module)
- Nothing is deleted. A correction creates a new version with the user, the
  time and a mandatory reason; the original stays visible.
- Approved or posted documents are locked. Changing them requires a
  reversal plus a new document, never an edit.
- Every action is logged with user and server time. Users cannot set or
  change timestamps.
- Discounts and price changes after estimation require a permission and a
  reason, and are logged separately.

## Affected users and systems
All staff roles above, individual and corporate clients, the business's
accountant, 1C (to be retired), the tax authority's e-qaimə process.

## Constraints
- Replaces 1C, so it must meet Azerbaijani accounting and tax requirements
  (chart of accounts, VAT, e-qaimə, statutory reports). The accountant
  confirms these requirements before the accounting intents are designed.
- Opening balances (stock, receivables, payables, fixed assets, cash)
  migrate from 1C at a cut-over date.
- 1C keeps running in parallel until at least one full period closes with
  matching results in both systems.
- Works on phones and tablets in the workshop as well as office computers.
- Interface in Azerbaijani only for now.
- One branch; one formen at present, possibly more later.
- Cloud hosting (workshop internet is reliable; cheaper than a local server).
- Client messages go by WhatsApp and email.
- Payment methods: cash and bank transfer now, card later. Credit (deferred
  payment) is common, so receivables tracking is core.

## Out of scope for this intent
Screen design and the detailed rules of each module. Each gets its own
intent: foreman intake, warehouse and inventory, sales and purchases,
payments and contragent balances, fixed assets, financial statements,
analytics, client communication, fraud detection.

## How we will know it worked
- One car can travel the full lifecycle in the system, from intake to
  payment, with no paper and no retyping.
- Every amount in the financial statements can be traced back to the
  document and the person that created it.
- A parallel-run period closes with the same totals as 1C.

## Open questions
1. Who exactly is "management": only the owner, or other managers too?
   Can approval have an amount threshold, or a single approval for parts
   issued against a Qüsur aktı the client already approved?
2. The contract says whoever brings the car counts as the client's
   authorized representative. Will the business require a named approver
   per corporate client instead?
3. Who at Diesel Motors approves each intent?
4. Who is the accountant, and can they review the accounting requirements?
5. What else does 1C currently do (payroll, tax declarations, bank
   statement import)?
6. What cut-over date is realistic, and how much history must move from 1C?
7. In the first release (formen + warehouse), 1C is still running. Does the
   warehouse stock move to the new system from day one?
