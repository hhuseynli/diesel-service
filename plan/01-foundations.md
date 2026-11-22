# Plan 01: Foundations (milestone 1)

Status: ACCEPTED 2026-11-22 by Aykhan.
Sources: spec/00-backbone.md sections 2, 3, 3a, 5, 7, 10, 13; RISKS.md (R8, R11, R16, R21, R25);
skills `audit-rules`, `document-numbering`, `azerbaijani-ui`.

## Context

Nothing is built yet. Every later module (job orders, approvals, warehouse, accounting) depends
on guarantees that must hold even if application code is wrong:
- nothing is deleted;
- approved and posted documents never change;
- every write is attributed and audited;
- document numbers are gapless;
- a vehicle is its VIN, and plates are dated history.

Milestone 1 builds the project skeleton and these database guarantees, with tests that prove
them against real Postgres. It has no screens. The one placeholder page exists only to prove
that the translation setup and Playwright work.

## Decisions taken (from review with Aykhan, 2026-11-22)

| # | Decision |
| --- | --- |
| Q1 | **Migrations: drizzle-kit, plus `db:new --from`.** Tables come from `db/schema/*.ts` via `drizzle-kit generate`. Hand-written SQL (roles, triggers, seed) is drafted in `db/drafts/` (gitignored). `pnpm db:new <name> --from <draft>` then creates the migration with that content in one step. This is needed because the protect-paths hook blocks editing a migration file once it exists. |
| Q2 | **Rejected attempts are logged by the app.** `lib/audit` catches a rejected write and records it as an `audit_log` row with action `DENIED`, in a separate transaction, through a SECURITY DEFINER function. Postgres's server log also keeps the failed statement. |
| Q3 | **Columns added beyond the spec** (see "Spec updates needed" below): `documents.vehicle_id`, `documents.reverses_id`, `documents.vat_rate`, `user_roles.revoked_at/revoked_by/revoke_reason`. |
| Q4 | **A corrected version keeps the number.** It has the same number with version + 1, consumes no counter value, and links to its predecessor through `supersedes_id`. |
| Q5 | **The real cashier is seeded now**, as a personal account with the CASHIER role. It is not a shared "kassir" login (R11). It is done by a one-off script, `pnpm db:seed-user`, not a migration, for this reason: a migration file can never be edited, so the cashier's phone number would stay in git history for good (personal data, R20). Name and phone are open item O3. |

## Input from the Alış and Satış walkthrough (Aykhan, 2026-11-22)

This is how purchases and sales work in 1C today. It belongs to the warehouse milestone, but it was checked against milestone 1's shared document model so nothing here blocks it.

| What was described | Fits milestone 1 as | Left for spec/02 (warehouse) |
| --- | --- | --- |
| Supplier is a firm or an individual | `contragents.kind` FIZIKI or HUQUQI, `voen` optional | — |
| With VAT or without VAT, chosen per purchase | `documents.vat_rate` and line `vat_rate` (0 or 18) | Whether entered prices include VAT is a calculation and screen question (R16) |
| Taxi (delivery) cost added, and it "goes into the price" | Lines allow `item_id` null, so a cost line fits | **New: landed cost.** Delivery spread into item cost, which affects weighted average cost. Not in spec 02 yet. |
| Purchase date (the date goods were bought) | `doc_date` is set by the server at submission, so it is not this date | Supplier invoice date and number as user-entered business dates. Spec 02 §3.6 already lists them; they need columns. |
| Several warehouses ("anbar 1", or named "Tural", "Ivan"), grouped under "kontingent" | Not a documents column; `stock_moves.location_id` per spec 02 | **Conflicts with spec 02 "one location in release 1".** What a "kontingent" group is needs an answer. |
| New item created inside the purchase: code, vitrin nömrəsi, name, purchase price, sale price | — | **New: `vitrin nömrəsi`** (shelf or display number) on items. **Conflicts:** a sale price typed at purchase versus spec 02's `price_rules`. |
| Sale: car entry and exit dates, company, goods from stock, services | Services are items with kind `service`; dates come from the job order (milestone 2) | — |
| "Qeyd et" (save), then "registrasiya et" (register); later check whether it was processed | DRAFT → SUBMITTED → APPROVED → POSTED; status is visible on the document | — |

Nothing here changes milestone 1. The three conflicts above (landed cost, warehouses, sale price at purchase) are for Aykhan to settle in spec/02 before milestone 5.

## Conventions used throughout

- **Tables:** every table in `public` has the following columns. `audit_log` and `document_counters` are exceptions; their columns are listed in the Tables section.
  - `id uuid PK DEFAULT gen_random_uuid()`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `created_by uuid NOT NULL REFERENCES users(id)`
  
  A BEFORE INSERT trigger overwrites `created_at` and `created_by` with server values, so whatever the client sends is ignored.
- **Status and type columns:** these are `text` with a CHECK constraint, not Postgres enums. The reason is that `ALTER TYPE ... ADD VALUE` cannot run inside the transaction that Drizzle wraps migrations in.
- **Numbers:** money columns are `numeric(14,2)`, quantities `numeric(12,3)` and rates `numeric(5,2)`. Drizzle maps all of them in string mode, and TypeScript only does arithmetic on them through `lib/money`.
- **Time:** the server runs in UTC. The local date comes from the SQL function `baku_date(ts timestamptz DEFAULT now())`, which returns `(ts AT TIME ZONE 'Asia/Baku')::date`. The year is `extract(year FROM baku_date(...))`.
- **Actor:** stored per transaction as a Postgres setting:
  - `app.user_id` is set with `set_config(..., true)`.
  - `app.reason` is optional on INSERT and **required on every UPDATE**.
  - Both are set only through `lib/audit`.
- **Custom SQLSTATEs**, mapped to typed errors in `lib/db/errors.ts`:

  | Code | Meaning |
  | --- | --- |
  | `DM001` | document locked |
  | `DM002` | delete or truncate forbidden |
  | `DM003` | actor missing, inactive or not allowed |
  | `DM004` | reason required |
  | `DM005` | column or row immutable |
  | `DM006` | invalid status transition |

  Postgres's own codes also map: `42501` is permission denied and `23505` is a unique violation.
- **Database roles** are cluster-level. The dev Postgres container creates them in `docker/initdb/01-roles.sh`; for production, the README gives the same SQL to run once.
  - `diesel_migrator` (LOGIN) owns the schema and runs migrations. It has CREATEDB in dev and CI only, so tests can create databases.
  - `diesel_app` (LOGIN, NOINHERIT) is the only role the app and the tests use.
- **Postgres port:** compose publishes Postgres on host port **5433**, because a local Postgres already listens on 5432.

## Tables (migration `0000_core_tables`, generated from `db/schema/`)

| Table | Columns (beyond id/created_*) | Constraints |
| --- | --- | --- |
| `settings` | key text, value jsonb, effective_from timestamptz DEFAULT now() | UNIQUE(key, effective_from). Never updated; a change is a new row. |
| `users` | full_name, phone, email, pin_hash, is_active bool DEFAULT true, is_system bool DEFAULT false | phone UNIQUE, CHECK `^\+\d{8,15}$`. At most one `is_system` row. |
| `user_roles` | user_id FK, role, revoked_at, revoked_by FK, revoke_reason | role ∈ OWNER, MANAGEMENT, FORMEN, WAREHOUSEMAN, CASHIER, BOOKKEEPER, MECHANIC. The three revoke columns are all null or all set. UNIQUE(user_id, role) WHERE revoked_at IS NULL. |
| `contragents` | kind, name, voen, phone, email, address, bank_details jsonb, is_customer, is_supplier, is_active | kind ∈ FIZIKI, HUQUQI. voen CHECK `^\d{10}$`, UNIQUE WHERE NOT NULL. CHECK (is_customer OR is_supplier). |
| `vehicles` | vin, make, model, year smallint, engine, qr_token, decode_source | vin UNIQUE, CHECK `^[A-HJ-NPR-Z0-9]{17}$`, no check digit (see flag F7). qr_token UNIQUE DEFAULT 32 random hex characters, from gen_random_uuid() with the dashes removed (R8). year between 1950 and 2100. |
| `vehicle_plates` | vehicle_id FK, plate_display, plate_normalized **GENERATED ALWAYS AS** `upper(regexp_replace(plate_display,'[[:space:]-]','','g'))` STORED, valid_from date, valid_to date, status, source, job_order_id uuid (no FK until milestone 2) | status ∈ ACTIVE, ENDED, UNCONFIRMED. source ∈ INTAKE, CONTRACT, IMPORT. CHECK `(status='ENDED') = (valid_to IS NOT NULL)`. CHECK valid_to ≥ valid_from. CHECK plate_normalized ≠ ''. **UNIQUE(vehicle_id) WHERE status='ACTIVE'** and **UNIQUE(plate_normalized) WHERE status='ACTIVE'**. Index on plate_normalized with text_pattern_ops. The spec's `recorded_by` is `created_by`. |
| `documents` | type, number, version int DEFAULT 1, status DEFAULT 'DRAFT', doc_date date, job_order_id uuid (no FK until milestone 2), vehicle_id FK, contragent_id FK, vin_snapshot, plate_snapshot, vat_rate, total_ex_vat, vat_amount, total (DEFAULT 0), supersedes_id FK self UNIQUE, reverses_id FK self, annul_reason | type ∈ QUSUR_AKTI, ELAVE_AKT, QIYMET_PROTOKOLU, TEHVIL_TESLIM, SATIS, ALIS, MEDAXIL, MEXARIC, SILINME, INVENTAR. status ∈ DRAFT, SUBMITTED, REJECTED, APPROVED, POSTED, ANNULLED. Number CHECK `^[A-Z]{2}-\d{4}-\d{6}$`. Rule: DRAFT ⇒ number null; SUBMITTED, REJECTED, APPROVED or POSTED ⇒ number set; ANNULLED may be either. ANNULLED ⇒ annul_reason non-empty. total = total_ex_vat + vat_amount. (version > 1) ⇔ supersedes_id set. UNIQUE(type, number, version). |
| `document_lines` | document_id FK, line_no, item_id uuid (no FK until the warehouse milestone), quantity, unit, unit_price, discount DEFAULT 0, discount_reason, vat_rate, line_total | UNIQUE(document_id, line_no). quantity ≠ 0. discount ≥ 0. A discount > 0 needs a non-empty discount_reason (R5). |
| `document_counters` | doc_type, year int, last_number int, created_at, created_by | PK(doc_type, year). last_number between 1 and 999999. Not audited: the number itself shows up in the audit row of the document. |
| `audit_log` | id bigint identity PK, at timestamptz DEFAULT now(), txid bigint DEFAULT txid_current(), table_name, record_id uuid, action, before jsonb, after jsonb, user_id FK null, reason, details jsonb | action ∈ INSERT, UPDATE, DENIED. user_id may be null only for DENIED. |
| `attachments` | storage_key UNIQUE, sha256, mime_type, size_bytes bigint, linked_table, linked_id | sha256 CHECK `^[0-9a-f]{64}$`. size_bytes > 0. linked_table and linked_id are both null or both set (see flag F8). |

## Hand-written migrations (each one drafted in `db/drafts/`, then added with `pnpm db:new <name> --from`)

1. **`0001_roles_grants`**
   - `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ... TO diesel_app`.
   - `diesel_app` gets these privileges:

     | Privileges | Tables |
     | --- | --- |
     | SELECT, INSERT, UPDATE | users, user_roles, contragents, vehicles, vehicle_plates, documents, document_lines, document_counters |
     | SELECT, INSERT | settings, attachments |
     | SELECT only | audit_log |

   - No DELETE or TRUNCATE is granted anywhere.
   - `REVOKE EXECUTE ON ALL FUNCTIONS ... FROM PUBLIC`.
   - No default privileges: every future table must be granted explicitly in its own migration, and the catalog tests fail if one isn't.
2. **`0002_actor_and_audit`**
   - Functions `baku_date()` and `current_actor()`. `current_actor()` reads `app.user_id` and raises DM003 when:
     - it is missing;
     - the user is inactive;
     - it is the system user and `session_user` is not `diesel_migrator`.
   - `stamp_created()`, BEFORE INSERT: forces `created_at` and `created_by`. On UPDATE, changing `created_*` raises DM005.
   - `audit_row()`, AFTER INSERT OR UPDATE, SECURITY DEFINER, owner diesel_migrator, `search_path` pinned:
     - writes table, id, action, `to_jsonb(OLD/NEW)` with `pin_hash` removed, actor and reason;
     - on UPDATE, raises DM004 if `app.reason` is empty;
     - skips UPDATEs that changed nothing.
   - `log_denied(table, operation, sqlstate, message)`, SECURITY DEFINER, EXECUTE granted to diesel_app.
   - The audit trigger is attached to: settings, users, user_roles, contragents, vehicles, vehicle_plates, documents, document_lines, attachments.
3. **`0003_integrity_guards`**
   - `forbid_delete`: BEFORE DELETE row trigger and BEFORE TRUNCATE statement trigger, raising DM002, on **every** table in public. This stops the owner role as well as the app.
   - `attachments` and `audit_log`: BEFORE UPDATE raises DM005.
   - `documents_guard`, BEFORE INSERT OR UPDATE:
     - **INSERT:** status must be DRAFT and number null.
     - **Allowed transitions:**
       - DRAFT → SUBMITTED, ANNULLED
       - SUBMITTED → APPROVED, REJECTED, ANNULLED
       - REJECTED → SUBMITTED, ANNULLED
       - APPROVED → POSTED
       - anything else raises DM006.
     - **Locked rows:** when OLD.status is APPROVED, POSTED or ANNULLED, the update raises DM001. The one exception is APPROVED → POSTED where `to_jsonb(NEW) - 'status'` equals `to_jsonb(OLD) - 'status'`.
     - **Immutable once set** (DM005): type, number, version, supersedes_id, reverses_id, doc_date, vin_snapshot, plate_snapshot.
     - **On DRAFT → SUBMITTED:** forces `doc_date := baku_date()`.
   - `document_lines_guard`, BEFORE INSERT OR UPDATE: raises DM001 when the parent document is APPROVED, POSTED or ANNULLED, and DM005 if `document_id` changes.
4. **`0004_seed`**
   - Sets `app.user_id` locally to the system user's UUID.
   - Inserts the system user (fixed UUID `00000000-0000-0000-0000-000000000001`, is_system, is_active false, no roles).
   - Inserts settings:
     - `company`: legal_name "Highest Service MMC"; voen, address and bank are null until the real values are given (open item O1).
     - `vat_rate`: `{"percent":"18.00"}`, effective 2026-01-01 Asia/Baku.

## lib modules (business rules live here; all take a Drizzle transaction `tx`)

- **`lib/db/client.ts`**: a `pg` Pool built from DATABASE_URL (the app role), plus the Drizzle instance.
- **`lib/db/errors.ts`**: maps SQLSTATE to `DocumentLockedError`, `DeleteForbiddenError`, `PermissionDeniedError`, `ActorRequiredError`, `ReasonRequiredError`, `ImmutableError` and `InvalidTransitionError`.
- **`lib/audit`**:
  - `withActor(db, { userId, reason? }, fn)` opens a transaction, sets `app.user_id` and `app.reason`, and runs `fn`.
  - If a typed denial error is thrown, it calls `log_denied` in a **new** transaction with the same actor, then rethrows.
  - `setReason(tx, reason)` changes the reason partway through a transaction.
  - System-generated reasons are message keys, for example `audit.plateMovedToOtherVehicle`, which the UI will translate.
- **`lib/money`**:
  - Exact arithmetic on integer minor units using `bigint`. `Money` counts qəpik; `Quantity` counts thousandths of a unit.
  - Functions: `parse(dbString)`, `toDb()`, `add`, `sub`, `mulQty` and `mulRate`, rounding half-up to 2 decimals, plus `compare`.
  - `formatAz()` produces `1 234,50`.
  - It refuses JS `number` input. VAT calculation is out of scope (R16 and D4 are still open).
- **`lib/numbering`**:
  - `prefixes.ts` maps types to prefixes (open item O2): QUSUR_AKTI QA, ELAVE_AKT EA, QIYMET_PROTOKOLU QP, TEHVIL_TESLIM TT, SATIS ST, ALIS AL, MEDAXIL MD, MEXARIC MX, SILINME SL, INVENTAR IN.
  - `format.ts` is pure: `formatNumber(prefix, year, seq)`.
  - `assignNumber(tx, docType)` runs one atomic statement:
    `INSERT INTO document_counters (doc_type, year, last_number, …) VALUES ($1, extract(year from baku_date()), 1, …) ON CONFLICT (doc_type, year) DO UPDATE SET last_number = document_counters.last_number + 1 RETURNING year, last_number`.
    The conflicting row stays locked until the transaction ends, which is the same guarantee as `SELECT … FOR UPDATE` and also covers the first number of a year without a race. A rollback releases the increment. Above 999999 it throws.
- **`lib/settings`**: `getSetting(tx, key)` returns the row with the latest `effective_from` that is ≤ now().
- **`lib/documents`**:
  - `createDraft(tx, header, lines)`.
  - `submitDocument(tx, id)`:
    - normally takes a number from `assignNumber`;
    - for a version with `supersedes_id`, reuses the predecessor's number with version + 1 and no counter call;
    - copies `vin_snapshot` and `plate_snapshot` from `vehicle_id` and its ACTIVE plate.
  - `annulDocument(tx, id, reason)`.
  - `createNewVersion(tx, approvedId)` copies the header and lines into a DRAFT version that points back through supersedes_id.
  - Approving documents is not in this milestone (the approval engine is milestone 3). Tests use a fixture that sets SUBMITTED → APPROVED.
- **`lib/vehicles`**:
  - `normalizeVin` and `isValidVin` (pure). `normalizePlate` (pure) must match the database's generated column.
  - `createVehicle(tx, { vin, …, plate? })`.
  - `recordPlate(tx, { vehicleId, plateDisplay, source, jobOrderId? })`, in one transaction:
    1. Lock the vehicle row.
    2. If the plate is unchanged, return without changes.
    3. Set ACTIVE rows with the same normalized plate on **other** vehicles to UNCONFIRMED.
    4. Set this vehicle's ACTIVE and UNCONFIRMED rows to ENDED with `valid_to = baku_date()`.
    5. Insert the new ACTIVE row.
    6. Return `{ changed, conflicts: [{ vehicleId, vin }] }`. `conflicts` is the data for the notice the formen sees (acceptance criterion 9).

    A unique violation from a race with another transaction becomes `PlateConflictError`, and the caller retries once.
  - `searchByPlate(tx, query)`:
    - normalizes the query (at least 2 characters) and does a prefix match on current and former plates;
    - each result has a label CURRENT, FORMER (with `usedUntil`) or UNCONFIRMED, plus the vehicle's VIN;
    - sorted exact matches first, then ACTIVE, then most recent `valid_to`.

## Files that change

- **Root:** `package.json` (scripts below), `pnpm-lock.yaml`, `.npmrc` (pnpm `use-node-version` pinned to Node 22), `.nvmrc`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore` (adds `db/drafts/`).
  - `eslint.config.mjs` uses next config + prettier, with `react/jsx-no-literals` turned on in `app/**` to enforce translations.
  - `drizzle.config.ts` points at MIGRATION_DATABASE_URL and `db/migrations`.
  - `docker-compose.yml` runs Postgres 16 as service `db`, publishes `5433:5432`, sets `max_connections=200` and TZ UTC, and mounts `docker/initdb`.
- **`docker/initdb/01-roles.sh`:** creates both roles and the `diesel` database owned by the migrator, with passwords from the environment.
- **App:** `app/layout.tsx`, `app/page.tsx` (placeholder showing a heading from translations), `i18n/request.ts` (next-intl with a single locale, `az`), `messages/az.json`.
- **`db/schema/`:** `index.ts`, `people.ts`, `contragents.ts`, `vehicles.ts`, `documents.ts`, `system.ts`.
- **`db/migrations/`:** `0000`–`0010` plus `meta/` (0005–0010: see "Changes during implementation").
- **`scripts/`:**
  - `db-new.ts`: `<name>` runs a schema-diff generate. `<name> --from <file>` runs `generate --custom`, writes the draft into the new file, and refuses if that file is not empty.
  - `check-migrations.sh`: fails if any `db/migrations/*.sql` is modified, renamed or deleted relative to `origin/main`, and runs `drizzle-kit check`.
  - `seed-user.ts`: `pnpm db:seed-user --name "<full name>" --phone +994XXXXXXXXX --role CASHIER`.
    - Runs as the migrator with the system actor.
    - Inserts the user (`pin_hash` null; login arrives in milestone 3) and the role, both audited.
    - Does nothing if the phone already exists, so the cashier isn't added twice.
    - Personal data goes on the command line only, never into git.
- **`lib/`:** `db/`, `audit/`, `money/`, `numbering/`, `settings/`, `documents/`, `vehicles/` as described above. Unit tests sit next to the code as `*.test.ts`.
- **`tests/db/`:**
  - `global-setup.ts`: rebuilds the template database `diesel_test_tpl` with migrations.
  - `helpers.ts`:
    - `createTestDb()` copies the template into a fresh database per test file;
    - it returns app and migrator pools;
    - it asserts `current_user = 'diesel_app'` on the app pool.
  - `fixtures.ts`: a test user (inserted as the system actor through the migrator) and `approveForTest`.
  - Test files: `*.db.test.ts`.
- **`e2e/smoke.spec.ts`:** the home page renders the translated heading.
- **`README.md`:** setup steps, ports, and the production role bootstrap.
- **`CLAUDE.md`:** adds `pnpm db:check` and the `db:new --from` workflow under Commands.

**Scripts:**

| Script | Command |
| --- | --- |
| `dev` | `next dev` |
| `build` | `next build` |
| `lint` | `eslint . && prettier --check .` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run --project unit` |
| `test:db` | `vitest run --project db` |
| `test:e2e` | `playwright test` |
| `db:new` | `tsx scripts/db-new.ts` |
| `db:migrate` | `drizzle-kit migrate` |
| `db:check` | `scripts/check-migrations.sh` |
| `db:seed-user` | `tsx scripts/seed-user.ts` |

## Order of work (each step ends green and with a commit on branch `m1-foundations`)

0. **Human prerequisites** (Claude cannot do these):
   - push the initial commit to main and set up branch protection (from the setup session);
   - `brew reinstall --cask docker-desktop` and open Docker once;
   - after step 3, create `.env.example` from the content Claude prepares (the protect-paths hook blocks `.env.*`, which includes `.env.example`), then `cp .env.example .env`.
1. Commit this plan as `plan/01-foundations.md`.
2. **Scaffold:** Next.js (App Router, TypeScript, no Tailwind yet), pnpm, Node 22 pin, ESLint, Prettier, next-intl, placeholder page. Run lint and typecheck.
3. **Database setup:** docker compose, the role init script, `.env.example`. Then `docker compose up -d db` and log in as each role.
4. **Test tooling and pure code:**
   - Vitest projects `unit` and `db`, Playwright with chromium, the e2e smoke test.
   - `lib/money`, `lib/numbering/format` and `prefixes`, `lib/vehicles` VIN and plate normalization, each with unit tests.
5. **Schema:** the Drizzle schema, `0000` generated by `pnpm db:new core_tables`, `scripts/db-new.ts`, `db:check`, then `pnpm db:migrate`.
6. **Guarantees:** migrations `0001` to `0004`. **This is the riskiest step.**
7. **Database test harness** (template copied per file), then the catalog tests (privileges, trigger coverage). These are written **before** the domain code, so step 6 is proven in isolation.
8. **Domain code:** `lib/db/errors`, `lib/audit`, `lib/numbering.assignNumber`, `lib/settings`, `lib/documents`, `lib/vehicles` (recordPlate, searchByPlate).
9. Database tests for acceptance criteria 2, 4, 7, 8 and 9, and the numbering tests.
10. Write `scripts/seed-user.ts` and its test. Once O3 is answered, run it on the dev database. Then update README and CLAUDE.md. Run the full Proof below, then the `verifier` and `spec-checker` subagents, then open the PR.

## Risks

**Riskiest step: step 6, roles and triggers.** Mistakes there are silent. A grant that is too broad, a table without its trigger, or a test that runs as the owner instead of the app role would all leave the suite green while the guarantee is missing. These countermeasures show whether it works:
- `tests/db/catalog.db.test.ts` reads pg_catalog rather than a hand-kept list. For every table in `public` it checks:
  - `diesel_app` has no DELETE or TRUNCATE;
  - `audit_log` grants SELECT only;
  - `attachments` grants no UPDATE;
  - every table has the `forbid_delete` and `forbid_truncate` triggers;
  - every table except `audit_log` has `stamp_created`, and every table except {audit_log, document_counters} has `audit_row`.

  A future table that is missing any of these fails the build.
- Every database test asserts `current_user = 'diesel_app'` on the pool it uses. Owner-only checks go through the separate migrator pool.
- Each guarantee is tested twice: once as the app role (privilege denied) and once as the migrator (trigger denied).

**Second riskiest: numbering under concurrency.** The test runs 50 real parallel connections, not simulated ones.

**What could break later (warehouse and accounting):**
- **Locked rows mean progress can't be stored on a document.** Issued quantities, payments and the three-way match must live in their own tables (`stock_moves`, `payments`, `approvals`), never as columns updated on an approved document or line. Anyone who later adds an "issued_qty" column to `document_lines` will hit DM001. That is intended, but it needs to be known.
- **Approval with several steps.** For SATIS (management, then cashier), the document stays SUBMITTED until the last step. The steps live in `approvals` (milestone 3). Nothing here blocks that.
- **Posting.** APPROVED → POSTED changes only the status. Ledger links (journal_entries.document_id) point to the document; the document never points to them. If accounting wants `posted_at` or `posted_by` on the document, the guard trigger must allow those columns in the same change. That would be a deliberate new migration.
- **New tables must be added to the triggers and grants in their own migration.** The catalog test enforces this.
- **VAT method (D4/R16)** isn't implemented. `documents.vat_rate` and the line-level `vat_rate` both exist, so either method fits without a schema change.
- **item_id and job_order_id have no foreign keys yet.** Their milestones add them with `NOT VALID` then `VALIDATE`. Until then, test data could hold dangling ids. It won't in production, because no data exists before those milestones.
- **audit_log grows with every write.** It can be partitioned by month later without changing the API.
- **Actor integrity:** `app.user_id` is set by our server. The database can't prove which human is behind it. That is R11's job: PIN switching in milestone 3.

**Options not chosen:**
- **Postgres sequences or `max+1` for numbers:** sequences skip numbers on rollback, and `max+1` races (skill: document-numbering).
- **`SELECT … FOR UPDATE` written as separate statements:** same lock as the upsert, but it needs extra code for the first row of a year.
- **Postgres enums:** awkward to extend inside Drizzle's migration transaction.
- **Auditing only in app code:** misses writes that don't go through the helper. Triggers can't be skipped by the app role.
- **pgaudit:** logs statements, not before/after rows, and managed-cloud support varies.
- **Row-level security:** not needed while there is one company. Its place is the client-portal visibility rule (acceptance criterion 10, a later milestone).
- **Rolling back a transaction per test:** fails for concurrency tests, and cleanup by DELETE is impossible by design. Hence a database copied from a template per file.
- **Testcontainers:** still needs Docker, and compose is already required for `pnpm dev`.
- **`decimal.js`:** unnecessary, because bigint minor units are exact and add no dependency.
- **`postgres-js`:** works too. `pg` was picked for its mature Pool behaviour and plain `err.code`.
- **Default privileges for future tables:** explicit grants per migration are safer. A missing grant fails loudly, while an inherited grant that is too broad would pass silently.
- **Tailwind and PWA:** deferred to milestone 4 (screens).

## Spec updates needed (Aykhan to apply to spec/00; Claude must not edit spec/)

This plan already assumes these changes.

| # | Spec text | Problem | This plan does |
| --- | --- | --- | --- |
| F1 | §13.2 "the attempt is logged" | A rejected statement rolls back its own transaction, so nothing written inside it survives. | The app writes a `DENIED` audit row in a separate transaction. Postgres's server log also records the statement. Raw psql attempts appear only in the server log. |
| F2 | §5.3 APPROVED and POSTED "cannot be updated" | POSTED comes after APPROVED, so the APPROVED → POSTED change itself is an update. | Allow only that status change and nothing else. |
| F3 | §3 documents fields | There's no vehicle link (job_orders arrives later), so §3a's VIN and plate snapshots can't be built or tested. | Add nullable `vehicle_id`. Milestone 2 adds a check that it matches the job order's vehicle. |
| F4 | §5.3 "or a reversing document" | No column links a reversing document to the original. | Add `reverses_id`. |
| F5 | §2 "Documents store the rate they used" | The header has no rate field, and the document-total VAT method (D4) needs one. | Add `documents.vat_rate`. |
| F6 | §3 user_roles; "nothing is deleted" | Removing a role would need a DELETE. | Add `revoked_at`, `revoked_by` and `revoke_reason`. |
| F7 | §3 VIN "17 chars, validated" | Older and CIS-market trucks can have chassis numbers that aren't 17 characters. The check-digit rule applies only to North American vehicles. | Enforce 17 characters, no I, O or Q, and no check digit, exactly as the spec says. **The owner should confirm that no current client vehicle has a non-standard VIN** (related to R19). |
| F8 | §3 attachments linked_table/linked_id, immutable | A photo uploaded before its record exists can never be linked afterwards. | Make both columns nullable. The authoritative link is the referencing column, for example `intake_photos.attachment_id`, which spec 01 already uses. |
| F9 | §5.2 "for corrections, a mandatory reason" | The database can't tell a correction from a workflow step. | Require a reason on **every** UPDATE. Workflow steps pass a reason key. |
| F10 | §5.3 lock list | ANNULLED isn't mentioned. | Freeze ANNULLED documents too, because they are terminal. |
| F11 | §3a rule 5 | It doesn't say what happens to an UNCONFIRMED plate once its own car comes back. | That car's new plate ends the UNCONFIRMED row (`valid_to` = today). |
| F12 | §3a `recorded_by` | It duplicates `created_by`. | Map `recorded_by` to `created_by`. |
| F13 | §7 "Once numbered, a document can be annulled" vs §5.3 | An APPROVED or POSTED document is numbered but locked. | Only DRAFT, SUBMITTED and REJECTED documents can be annulled. An approved one is corrected by a new version or a reversing document. |
| F14 | §2 and R8: `vehicles.vin` and `qr_token` | The spec doesn't say whether these may ever change. | Both can be changed today, with a reason and an audit row (for example, a mistyped VIN). **Decide** whether VIN corrections should be blocked or need management. |
| F15 | §5.1 audit_log append-only, and R20 | Names, phones and VOEN in audit rows are kept forever and can't be deleted. | Kept as the spec says. **Check** this against Azerbaijani personal-data rules when R20 is decided. |

**Open items** (these don't block milestone 1):
- **O1:** the company's VOEN, address and bank details for the `company` setting.
- **O2:** confirm the number prefixes above. They print on legal documents, and are easy to change only before the first real document.
- **O3:** the cashier's full name and phone, for `pnpm db:seed-user`.
- **O4 (for spec/02):** landed cost (taxi), several named warehouses and "kontingent", `vitrin nömrəsi`, and sale price at purchase versus `price_rules`. See the walkthrough section.

## Changes during implementation

Recorded as required by CLAUDE.md. None of them changes behaviour the plan promised.

| What | Why |
| --- | --- |
| Migration `0005_denial_context` re-creates the raising trigger functions with `TABLE` and the row id in `DETAIL` | Without them, a `DENIED` audit row could not say which table or row the refused write targeted. |
| Migration `0006_actor_default_null_safe` changes the `created_by` default to `nullif(current_setting('app.user_id', true), '')::uuid` | On a reused connection, the cleared setting is `''`, not NULL. `''::uuid` failed with 22P02 before `stamp_created` could raise the intended DM003. Found by `audit.db.test.ts`. |
| Migration `0007_forbid_delete_any_table` fixes `forbid_delete` | `0005` read `OLD.id`, which `document_counters` lacks. Deletes there failed with 42703 instead of DM002; still refused, but with the wrong error. Found by `ac2-immutability.db.test.ts`. |
| `stamp_created` also runs on `document_counters` | The table has `created_*` columns like the others, and assigning a number now also requires an actor. |
| `.env.example` is created by a human | The protect-paths hook matches `.env.*`, which includes `.env.example`. |
| New reason key `audit.plateRecorded` | Without it, a car's first plate was audited with the reason "plate replaced". |
| Seed logic is in `lib/users/seed.ts`; `scripts/seed-user.ts` only parses arguments | Business rules live in `lib/` (CLAUDE.md), and the test calls the function directly. |
| P11–P13 are three `describe` blocks in `tests/db/plates.db.test.ts`, not three files | They share the vehicle and plate fixtures. |
| Extra test helpers: `tests/db/env.ts`, `tests/db/documents-fixtures.ts`; `lib/db/types.ts` for the `Db`/`Tx` types | Shared by the test files and lib modules. |
| Known limitation | If a corrected version (v2) is annulled, `supersedes_id` stays taken, so the original can't get another version. To revisit with the approval engine in milestone 3. |
| Migration `0008_counter_guards` | (a) `stamp_created` from 0005 read `OLD.id`, so a `created_*` change on `document_counters` failed with 42703 instead of DM005 (found by the verifier). (b) New `document_counters_guard`: a counter only moves forward by exactly one, and the app role can only start one at 1. Gapless numbering no longer rests only on `lib/numbering`. The migration role may start a counter elsewhere, which continuing 1C numbering at cut-over may need. |
| Migration `0009_row_history_guards` | Found by the spec-checker. A numbered document can no longer change its vehicle, client or job order. `vehicle_plates` rows allow only ACTIVE → ENDED/UNCONFIRMED and UNCONFIRMED → ENDED (section 3a: nothing is overwritten). `user_roles` rows are only ever revoked: they can't be edited, and a revocation can't be undone. |
| Migration `0010_plates_guard_generated_column` | 0009's plate guard compared `plate_normalized`, which is still NULL in `NEW` inside a BEFORE trigger, so it refused every legitimate plate change. It now ignores that column; `plate_display` is still compared. |
| `withReason(tx, reason, fn)` in `lib/audit` | Lib functions set their reason key only for their own writes, then restore the caller's. Before this, a key like `audit.plateRecorded` leaked onto later, unrelated updates and weakened F9. |
| A corrected version copies its predecessor's VIN and plate snapshots | It is the same numbered document, revised, so it keeps what the original was issued with. |
| `createDraft` checks VAT rates with `Rate.parse` | A value like `18.005` is now refused instead of rounded by Postgres. |
| `0001` uses `ALTER DEFAULT PRIVILEGES FOR ROLE diesel_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` | No functions existed when 0001 ran, so this is the statement that covers the functions created afterwards. The catalog test checks the result. |
| `lib/db/errors.ts` doesn't map 23505 to a general error | The only unique violation with a meaning today is the plate race, which `recordPlate` turns into `PlateConflictError`. |
| `DENIED` rows store the error class (e.g. `DocumentLockedError`) in `details.operation`, not DELETE/UPDATE | The database reports the refusal, not the statement type. `details.message` has the full text. |
| Writing the `DENIED` row is best effort | If it fails, the original refusal is still thrown and the failure goes to the server log. Postgres's own log (`log_min_error_statement`) records every refused statement as well. |
| `vehicle_plates.plate_display` is limited to 1–20 characters | A sanity limit, not a format check. Foreign plates are otherwise accepted as written (section 3a.3). |
| Other files: `AGENTS.md` (written by `next dev`), `pnpm-workspace.yaml` (pnpm build-script allowlist), `lib/users/roles.ts`, `tests/db/history-guards.db.test.ts` | Supporting files. |
| Not enforced yet: roles and permissions | Any active user can write anything, including MECHANIC, which spec §10 gives no permissions. Role checks, `change_price` and the owner's price-change report (R5) belong to the approval engine and permissions milestone (3). |
| Not done yet: header totals, VAT and `documents.vat_rate` from settings | These wait for the VAT method (D4, R16) in the warehouse milestone. `line_total` is price × quantity − discount, excluding VAT, with the discount as an amount. |
| Superseded versions | Nothing marks v1 as superseded. The current version is the one no other row points to through `supersedes_id`. |

## Proof

Run in order on a clean checkout with Docker running and `.env` copied from `.env.example`. The verifier runs every item.

| # | Command or test | Proves |
| --- | --- | --- |
| P1 | `pnpm exec node --version` → `v22.*` | Node 22 pin |
| P2 | `pnpm lint && pnpm typecheck` → exit 0 | lint, types, no JSX string literals in `app/` |
| P3 | `docker compose up -d db && pnpm db:migrate` → applies 0000–0010 | compose, roles, migrations |
| P4 | `pnpm db:check` → exit 0 | migrations are append-only and match the schema |
| P5 | `pnpm test` → `lib/money/money.test.ts`, `lib/numbering/format.test.ts`, `lib/vehicles/vin.test.ts`, `lib/vehicles/plates.test.ts` pass | exact money and rounding; `QA-2026-000123`; "90-JG-526" normalizes to "90JG526"; VIN rules |
| P6 | `pnpm test:db` → `tests/db/catalog.db.test.ts` | the app role has no DELETE or TRUNCATE anywhere; audit_log SELECT only; attachments no UPDATE; every table has its triggers |
| P7 | `tests/db/audit.db.test.ts` | an insert and an update each write a row with before, after, user and reason. UPDATE without a reason gives DM004. A write without an actor gives DM003. An inactive user gives DM003. The system actor via the app role gives DM003. A client-sent `created_at` is overridden. `pin_hash` never appears in the audit log. |
| P8 | `tests/db/ac2-immutability.db.test.ts` (**acceptance criterion 2**) | **Approved document:** updating the header, updating a line, inserting a line and annulling each give DM001, plus a `DENIED` audit row. **APPROVED → POSTED** is allowed with the status as the only change; with any other change it gives DM001. **POSTED and ANNULLED** are frozen. The same checks pass via the migrator, so the trigger works without relying on privileges. **DELETE and TRUNCATE on every table** give 42501 as the app (plus a `DENIED` row) and DM002 as the migrator. **audit_log and attachments** reject UPDATE (42501 as the app, DM005 as the migrator). **`createNewVersion`** produces the same number at v2 and leaves the original unchanged. |
| P9 | `tests/db/ac4-numbering-gapless.db.test.ts` (**acceptance criterion 4**) | **Scenario:** a random interleaving of create, submit, annul-draft, annul-submitted, approve and rolled-back submit across QUSUR_AKTI and SATIS. **Result:** each type's numbers are exactly 1..n with no gaps and no duplicates. Annulled documents keep their numbers; versions consume none. |
| P10 | `tests/db/numbering.db.test.ts` (**document-numbering skill**) | 50 concurrent submissions on 50 connections give 50 consecutive numbers, with no gaps or duplicates. A rolled-back transaction doesn't consume a number. `baku_date('2026-12-31 21:00Z')` is in year 2027. Going past 999999 throws. |
| P11 | `tests/db/plates.db.test.ts`, describe "acceptance criterion 7" (**acceptance criterion 7**) | A document is submitted under plate A. The plate changes to B. The document still holds A and the right VIN; a new document gets B. History has A as ENDED with `valid_to` = today, and B as ACTIVE. Audit rows exist for both plate rows. The snapshot columns can't be updated (DM005). |
| P12 | `tests/db/plates.db.test.ts`, describe "acceptance criterion 8" (**acceptance criterion 8**) | Searching A, in any spacing, hyphen or case variant, finds the vehicle labeled FORMER with `usedUntil`. Searching B gives CURRENT. Every result carries its VIN. |
| P13 | `tests/db/plates.db.test.ts`, describe "acceptance criterion 9" (**acceptance criterion 9**) | Car 1 has plate P. `recordPlate(car2, P)` succeeds. Car 1's row becomes UNCONFIRMED, its other rows are untouched, car 2's row is ACTIVE, and the return value has `conflicts=[car1]`. The two unique indexes hold. Two concurrent `recordPlate` calls for the same plate leave exactly one ACTIVE row. |
| P14 | `pnpm test:e2e` → `e2e/smoke.spec.ts` | Next.js, next-intl and `messages/az.json` render; Playwright works |
| P15 | **Run by a human** (the guard-bash hook blocks any command containing `DELETE FROM`, including Claude's and the verifier's): `psql "$DATABASE_URL" -c "DELETE FROM users"` → `permission denied` | the guarantee holds outside the app |
| P17 | `tests/db/history-guards.db.test.ts` | Plate rows can't be renamed, moved or revived. Roles are revoked once, never edited. A numbered document keeps its vehicle. A corrected version keeps the original's number and snapshots. A rejected document resubmits with the same number and uses no new one. Reasons don't leak between writes. A counter from another year doesn't affect this year's. The seeded company and 18% VAT are present. A discount needs a reason. The database refuses malformed VINs. QR tokens are random and unique. |
| P16 | `tests/db/seed-user.db.test.ts`; then, once O3 is known, `pnpm db:seed-user … --role CASHIER` and `psql "$DATABASE_URL" -c "select u.full_name, r.role from users u join user_roles r on r.user_id=u.id where r.role='CASHIER'"` | **Test:** the user and role rows are created with audit rows, the system user is the actor, and a second run makes no change. **Run:** the real cashier exists with the CASHIER role. |

## Answers to the three review questions

- **What could break later:** see "What could break later" under Risks. The main constraint is that any progress state must live in its own table, never on a document.
- **Riskiest step and how we'll know:** step 6. We know it works when the catalog tests (P6) and the double-role tests (P8) pass, and when they are written before the domain code (step 7).
- **Could an engineer implement this from the plan alone:** yes, for the schema, triggers, modules and tests; every column, constraint, error code and test case is listed above. They still need three things outside this file:
  - the human prerequisites (step 0);
  - the answers to O1 and O2, neither of which blocks the work;
  - library versions: the latest stable Next.js, Drizzle, Vitest and Playwright, pinned in the lockfile when the work happens.
