# Highest Service operations system (brand: Diesel Motors)

Job orders, warehouse, sales and (later) accounting for one auto service in
Baku. Replaces paper, WhatsApp and eventually 1C.

## Source of truth
- `intent/` says what and why. `spec/` says how. `plan/` holds the approved
  plan for the current work. `RISKS.md` lists known risks by ID (R1, R2...).
- Never change `intent/` or `spec/` yourself. If the code needs the spec to
  change, stop and say so.
- Every change starts from a committed `plan/*.md`. If the work departs from
  the plan, update the plan in the same commit.

## Stack
TypeScript, Next.js (App Router, PWA), PostgreSQL 16, Drizzle ORM with SQL
migrations, Vitest, Playwright. pnpm.

## Commands (created in milestone 1)
- Dev: `pnpm dev` (needs `docker compose up -d db`)
- Unit tests: `pnpm test`
- Database tests: `pnpm test:db` (real Postgres, never mocks)
- E2E: `pnpm test:e2e`
- Lint and types: `pnpm lint && pnpm typecheck`
- New migration: `pnpm db:new <name>`; apply: `pnpm db:migrate`
  - Schema changes: edit `db/schema/`, then `pnpm db:new <name>` generates the SQL.
  - Hand-written SQL (triggers, grants, data): draft it in `db/drafts/<name>.sql`
    (gitignored), then `pnpm db:new <name> --from db/drafts/<name>.sql`.
    Never write to a migration file after it exists; fix mistakes with a new one.
  - New tables need grants and triggers in their migration; `tests/db/catalog.db.test.ts`
    fails otherwise.
- Migration checks: `pnpm db:check` (append-only, and db/schema matches migrations)
- Seed a staff account: `pnpm db:seed-user --name "..." --phone +994... --role CASHIER`
- Dev Postgres is on localhost:5433. Writes go through `withActor()` in `lib/audit`.

Run lint, typecheck and the affected tests before reporting any task done,
and paste the output. If a test fails, fix the code, not the test.

## Rules that are never broken
- Vehicles are identified by VIN only. Plates are dated history (spec 00, 3a).
- Nothing is deleted. Cancel = status `ANNULLED` with a reason.
- Approved or posted documents are never updated; corrections create a new
  version or a reversing document. Enforced by database triggers.
- Timestamps come from the database (`now()`), never from the client.
- Money is `NUMERIC(14,2)`, quantities `NUMERIC(12,3)`. Never `number`
  arithmetic on money in TypeScript; use the `money` module.
- Document numbers are gapless; use the numbering module, never sequences.
- A document cannot be approved by the user who created it.
- All UI text goes through translation files (`messages/az.json`).
- Legal entity on documents is Highest Service MMC (from `settings`).

Skills in `.claude/skills/` hold the detailed rules: `audit-rules`,
`document-numbering`, `azerbaijani-ui`.

## Layout
- `app/` Next.js routes. `db/schema/` Drizzle schema. `db/migrations/` SQL.
- `lib/<module>/` domain logic (jobs, vehicles, documents, approvals, stock).
  Business rules live here, never in React components.

## Things Claude gets wrong
(Add a line here whenever the same mistake happens twice.)
- Editing an existing migration instead of adding a new one.
