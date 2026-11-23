# Plan 03: Approvals, permissions, sign-in and PIN switching (milestone 3)

Status: ACCEPTED 2026-11-22 (Claude, autonomously as Aykhan asked).
Branch `m3-approvals-auth`, based on `m2-job-orders`; rebased onto main once PR 2 merges.

Sources:
- spec/00-backbone.md §6 (approvals), §10 (accounts, the shared tablet, the permission matrix), §11 (lock after wrong PINs), §13 AC3 and AC5;
- spec/01 §1 (PIN switching, auto-lock);
- RISKS.md R1, R3, R10 and R11;
- plans 01 and 02. Their conventions hold here: explicit grants, no DELETE, actor and audit triggers, and guards that hold for the owner role.

## Context

Until now, any active user could do anything. Documents were approved by a test fixture, and nobody signed in. Milestone 3 adds three things:
- **Accounts:** every person has their own account. Office staff sign in with phone and password, with a second factor for management and the owner. On the shared tablet, people switch in with a personal PIN, and the tablet locks after 5 minutes.
- **The approval engine:** one engine for every document type, with the steps in `settings`, rejection with a comment, and a queue for management.
- **The permission matrix:** spec 00 §10's table of who may do what, enforced in `lib`. The critical approval rules are also enforced in the database.

The screens in this milestone are the minimum: sign-in, PIN switch and a signed-in placeholder. The tablet screens are milestone 4.

## Decisions

| # | Decision |
| --- | --- |
| A1 | **Client approval moves to milestone 6.** This covers individual clients approving by one-time code and corporate named approvers (`contract_approvers`, `client_portal_users`, R1). Both need message delivery (`notification_outbox`), which is milestone 6. The engine already has a step role `CLIENT` and a `method` column, so this needs no schema change later. Plan 02 Q4 moves with it. |
| A2 | **Approval steps come from settings.** The `approval_rules` setting is a map from document type to an ordered list of roles, seeded from §6. For SATIS, step 2 is `CASHIER` or `BOOKKEEPER`, chosen from the payment method given at submission. An `approvals` row is created per step when a document is submitted. A resubmission after rejection starts a new `round`. |
| A3 | **The database enforces the approval rules.** It also covers the owner role. |
| | • **Decided rows:** `decided_by` and `decided_at` are forced to the actor and `now()`, and a decided row is frozen. |
| | • **Who may decide:** not the document's creator (spec AC3), and only a holder of the step's role (OWNER counts for every internal role). |
| | • **Order:** steps are decided in order. |
| | • **Comments:** a rejection needs a comment. |
| | • **Document status:** a document reaches APPROVED only when every step of its current round is APPROVED. It reaches REJECTED only through a rejected step. |
| | The M1 fixture `approveForTest` now goes through the engine. |
| A4 | **D3 (approval mode for stock issues) stays open (R10).** The engine has a `method` column with values MANUAL and AUTO. Only MANUAL is used until the owner decides; MEXARIC arrives in milestone 5. |
| A5 | **The permission matrix (§10) is enforced in lib.** `requirePermission(tx, action)` reads the actor's active roles, and lib functions call it before writing. Job transitions use §4's "who triggers" column. **Database enforcement covers only approvals (A3).** Every other permission rests on the app, which is the database's only writer; the triggers would otherwise grow with every module. |
| A6 | **Credentials use node's built-in `scrypt`, with no new dependency.** Each user has a random salt, plus a server pepper (`AUTH_SECRET`, HMAC) that makes an offline brute force of a 4–6 digit PIN impossible without the server's secret. Passwords are at least 10 characters. TOTP (RFC 6238, 6 digits, 30 seconds) is implemented with `crypto.createHmac` and checked against the RFC's test vectors. TOTP secrets are encrypted with AES-256-GCM, using a key derived from `AUTH_SECRET`. |
| A7 | **Wrong PINs lock the account.** After 5 wrong PINs or passwords in a row, the account is locked (`users.locked_at`) until management or the owner unlocks it (§11). Attempts are logged in `login_attempts`, which is append-only and not audited, so failures don't flood the audit log. |
| A8 | **Sessions.** Sessions are stored server-side (`sessions`). The cookie holds a random token, and only its SHA-256 is stored. |
| | • **Office sessions:** 12 hours. |
| | • **Tablet sessions:** belong to a registered tablet (`tablet_devices`, with a long-lived device cookie). They lock after 5 minutes idle, checked on the server from `last_seen_at`; a locked session needs the PIN again. Switching user ends the current session. |
| | `withActor` takes its user from the session and never from the request body (R11, AC5). |
| A9 | **`sessions`, `login_attempts` and `tablet_devices` are operational tables.** They get no audit trigger, since `last_seen_at` changes on every request. Sign-in, sign-out and unlock are recorded as `login_attempts` rows. The catalog test gets an operational allowlist. |
| A10 | **Human step:** add `AUTH_SECRET` (32+ random bytes, base64) to `.env` and `.env.example`, because the hook stops Claude from writing them. Until it's set, tests and dev use a fixed development secret, and production refuses to start without one. |

## Tables and migrations

| Table | Columns | Notes |
| --- | --- | --- |
| `approvals` | document_id, round, step_no, required_role, status (PENDING, APPROVED, REJECTED, CANCELLED), method (MANUAL, AUTO), decided_by, decided_at, comment, plus created_* | UNIQUE(document_id, round, step_no). Audited. When a round is superseded or its document annulled, its pending steps become CANCELLED. |
| `users` gains | password_hash, totp_secret_enc, locked_at, lock_reason | All audited. `password_hash` and `totp_secret_enc` are removed from the audit JSON the same way as `pin_hash`. |
| `login_attempts` | user_id, kind (PIN, PASSWORD, TOTP, UNLOCK, SIGN_OUT), success, device_id, at | Append-only: the app role gets INSERT and SELECT. |
| `sessions` | user_id, token_hash, kind (OFFICE, TABLET), device_id, created_at, last_seen_at, expires_at, ended_at, end_reason | The app role may update only `last_seen_at`, `ended_at` and `end_reason`; a guard trigger enforces this. |
| `tablet_devices` | name, token_hash, registered_by, revoked_at | Registered by OWNER or MANAGEMENT. |

**Migrations:**
- generated: the tables and columns above;
- hand-written `approval_engine`:
  - grants and the standard triggers;
  - `approvals_guard`;
  - a new `documents_guard` that requires the approvals described in A3;
  - an updated `audit_row` that leaves out the credential columns;
  - the session guard;
  - `approval_rules` added to the seed settings.

## lib

- **`lib/permissions`:** `ACTIONS`, a mapping from each action to the roles allowed (the §10 matrix, plus the job transitions from §4); `can(tx, userId, action)`; `requirePermission(tx, action)`.
- **`lib/approvals`:**
  - `submitForApproval(tx, documentId, { paymentMethod? })` wraps `submitDocument` and creates the steps of the round;
  - `approveStep(tx, approvalId, comment?)` approves a step; after the last step the document becomes APPROVED;
  - `rejectStep(tx, approvalId, comment)` rejects a step and returns the document to REJECTED;
  - `pendingFor(db, userId)` is the queue: steps the user may decide, oldest first, excluding documents the user created.
- **`lib/auth`:**
  - `crypto.ts`: scrypt and pepper, TOTP, AES-GCM;
  - `credentials.ts`: setPin, setPassword, enableTotp, verify functions with lockout, `unlockUser`;
  - `sessions.ts`: create, validate (idle lock and expiry), end, `switchUser`;
  - `context.ts`: `getSessionUser()` for server actions, and `withSessionActor(fn)`, which runs `withActor` with the signed-in user.
- **Permission checks on existing lib functions:**
  - `openJob`;
  - `moveJob` and `cancelJob`, each by target status;
  - `resolveHold`;
  - the contract functions;
  - `createDraft`, by document type;
  - `removeVehicle`.

## Screens (minimal; all text in `messages/az.json`)

- **`/giris`:** office sign-in with phone and password, then the TOTP code when the user's role requires it.
- **`/pin`:** the tablet PIN switch. On a registered tablet, it shows a staff picker and a PIN field.
- **`/`:** when signed in, the user's name, their roles and a sign-out button. Otherwise it redirects to `/giris`, or to `/pin` on a tablet.

## Order of work

1. Commit this plan.
2. Write the schema and the generated migration.
3. Write `lib/auth/crypto` with unit tests (the RFC 6238 vectors, the scrypt round trip).
4. Draft the `approval_engine` migration, try it on a scratch database, then `db:new --from`.
5. Build `lib/permissions`, `lib/approvals`, `lib/auth`, and the permission checks in the lib functions from milestone 2.
6. Move the test fixtures to the engine. Write the database tests and the e2e sign-in and PIN-switch tests.
7. Run lint, typecheck and all the suites, then the verifier and spec-checker, then open the PR.

## Risks

- **Riskiest: moving documents_guard's APPROVED rule into the engine.** Every milestone 1 and 2 test that approves documents changes with it. The proof is that the milestone 1 suites stay green with `approveForTest` going through the engine, plus a database test showing that a direct `UPDATE … SET status = 'APPROVED'` is refused.
- **Session and idle lock done wrong would break R11** by putting the wrong person on a write. Tests cover:
  - no session gives no actor;
  - an idle tablet session is refused;
  - switching user ends the previous session;
  - the actor of a write is the session's user.
- **What this leaves for later:** milestone 6 adds client approval (CLIENT steps; A1). D3 auto-approval (A4) can be turned on without a schema change.
- **Options not chosen:**
  - **argon2 (a native dependency):** the pepper plus lockout cover the PIN's low entropy, and scrypt is built in.
  - **JWT sessions:** they can't be locked or ended on the server.
  - **Database triggers for the whole permission matrix:** see A5.

## Spec updates needed (Aykhan)

| # | Spec | This plan |
| --- | --- | --- |
| F24 | §6 SATIS step 2 "cashier if cash, bookkeeper if transfer" | The method is given at submission (A2). |
| F25 | §11 "locked after repeated wrong PINs" | 5 in a row; management or the owner unlocks (A7). |
| F26 | §10 office second factor | TOTP app codes for MANAGEMENT and OWNER (A6). |
| F27 | §6 client approval | Moves to milestone 6 together with message delivery (A1). |
| F28 | §6 TEHVIL_TESLIM has no approval step | It is signed on screen. A type with an empty rule is approved at submission. |
| F29 | §10 matrix rows for vehicles, contracts, the handover act, unlocking and tablets | See "Changes during implementation". |
| F30 | §4 "who triggers" for system transitions | HISSE_GOZLEYIR is set by the warehouse or the formen; ODENILDI by the cashier or the bookkeeper; BAGLANDI by whoever completes the second of payment and handover. LEGV follows plan 02 Q2. |
| F31 | §6 rules for QIYMET_PROTOKOLU and INVENTAR | Both are approved by management. |
| F32 | §10 the tablet and the second factor | Management and the owner sign in only at the office (password + TOTP), never by PIN. |

## Changes during implementation

| What | Why |
| --- | --- |
| Migrations are `0019_approvals_auth` (generated) and `0020_approval_engine` | Plan 02's second verifier pass took `0018` on the milestone 2 branch. This branch was rebased onto it, and its own `0018` was regenerated as `0019`; that migration had never been applied or pushed. |
| The tablet idle time is the setting `tablet_idle_seconds` (default 300) | Spec 01's 5 minutes is the default. It can be changed without code, and tests use a short value because the database forces `last_seen_at` to server time. |
| `lib/auth` is `crypto.ts`, `index.ts` (credentials, sign-in, sessions, tablets) and `context.ts` (cookies, `withSessionActor`) | The plan named `credentials.ts` and `sessions.ts` separately; the functions are the ones listed. |
| A MANAGEMENT or OWNER account without an enrolled TOTP can't sign in (`TOTP_NOT_ENROLLED`) | §10 requires the second factor. `enableTotp` enrols it (the user themself, or the owner); its screen comes with user management. |
| Management registers a tablet from the signed-in home page | It is the simplest way to put the device cookie on the tablet's browser. |
| Permissions not in the §10 matrix: `RECORD_VEHICLE` (FORMEN, MANAGEMENT), `MANAGE_CONTRACTS` (MANAGEMENT), `CREATE_HANDOVER_DOCUMENT` (FORMEN), `UNLOCK_USER` and `REGISTER_TABLET` (MANAGEMENT) | Needed by lib functions from earlier milestones and by sign-in (F29). |
| TESDIQ_GOZLEYIR → TESDIQLENDI by MANAGEMENT until milestone 6 | §4 says the client triggers it, and client approval arrives in milestone 6 (A1). |
| Tests that approve documents use MEDAXIL or SATIS instead of QUSUR_AKTI; test approvers hold OWNER | A QUSUR_AKTI step needs the client (A1). OWNER can decide every internal step, which covers the two-step SATIS. |
| `pnpm test:e2e` builds its own database (`diesel_e2e`) on every run (`e2e/prepare-db.ts`) | The browser tests never touch the dev database, and they start from known staff (`e2e/fixtures.ts`). |
| **Spec-checker review fixes:** | |
| The lock is computed, not stored (migration `0021` drops `users.locked_at` and `lock_reason`) | Five failed PIN, password or TOTP attempts in a row since the last successful one or the last UNLOCK lock the account. There is no column to race on, and the lock is nobody's action, whereas before it was recorded as the user locking themself. Attempts for one user are serialized by an advisory lock, so a burst of parallel guesses records at most five. Sign-outs no longer reset the count. Wrong TOTP codes count, as their own kind. |
| An unlock is a `login_attempts` row with `recorded_by` and `reason` | `login_attempts_guard` (0022) requires the recorder to be the acting manager or owner, and forces `at` to server time. |
| Management and the owner never sign in by PIN | Their accounts need the second factor (§10), so the PIN picker leaves them out. Mechanic-only accounts can't sign in at all yet (R3). Status `NOT_ALLOWED`. |
| On a registered tablet, an office sign-in becomes a TABLET session | So it gets the idle lock too. |
| Tablet sessions are bound to their tablet | `validateSession` refuses them, and ends them as `WRONG_DEVICE`, from another browser or on a revoked tablet. `revokeTablet` was added. |
| `withSessionUser(db, session, fn)` in lib, used by `context.withSessionActor` | It makes AC5 (the actor of a write is the session's user) testable without Next. |
| Migration `0022_approval_rule_integrity` | **Rules:** a step must be the rule's step for its position, with PAYMENT_CONFIRMER resolved to CASHIER or BOOKKEEPER. Steps are added in order and rounds follow one another. **Approval:** a round approves its document only when it is complete. **Cancelling:** a step can be cancelled only once its document has left SUBMITTED or its round was rejected, so `annulDocument` now annuls first. **Deciders:** neither the creator nor the round's submitter decides a step. **Backfill:** documents SUBMITTED before 0020 get their round (sales excluded; they are resubmitted with a payment method). |
| A refused permission is logged as a DENIED audit row | The same as a database refusal. |
| `AUTH_SECRET` is base64 and at least 32 bytes, checked at startup (`instrumentation.ts`) | **Rotation:** it keys the pepper, the token hashes (HMAC-SHA256, not plain SHA-256) and the TOTP encryption, so rotating it invalidates every PIN, password, session, tablet registration and TOTP enrolment. **Development:** without `AUTH_SECRET` and outside production, a fixed development secret is used. |
| A4 correction | Turning on D3 auto-approval needs a migration after all: `approvals_guard` refuses AUTO steps and always records the deciding person. |
| `submitDocument` starts the approval round itself; there is no separate `submitForApproval` | One function for the transaction that numbers a document and starts its approval. |
| `can(tx, action)` reads the actor from the transaction | The actor always comes from the transaction setting, never from an argument. |
| **Second verifier pass:** | |
| Migration `0023_auth_indexes` | Indexes on `login_attempts(user_id, at)`, `sessions(user_id)` and `sessions(device_id)`. |
| Migration `0024_auth_approval_hardening` | **Settings** are written only by the owner (§10) or by migrations. **Approval rules** fail closed: a missing rule refuses, where before it approved with no steps. **Approval steps:** a pending step can't change, so it can't carry a fake decider, and a rejection must be decided in the same transaction that rejects the document, so it can't be replayed. **Sign-in records:** a successful sign-in row is only ever the actor's own, so nobody else can reset a lock. A session belongs to its actor and lasts at most 12 hours. |
| Two locks instead of one | **PIN lock:** five wrong PINs in a row lock the account until management unlocks it, and end its sessions (§11). **Office pause:** five wrong passwords or TOTP codes within 15 minutes pause office sign-in only; sessions and the tablet are untouched. Without the split, anyone with a phone number could lock out the owner and every manager. |
| Sign-in answers don't reveal accounts | An unknown phone runs a dummy scrypt check. NOT_ALLOWED is shown only after a correct password. A malformed user id on the PIN form returns INVALID. |
| `pendingFor` leaves out the rounds the user submitted | The database refuses those decisions anyway (0022). |
| `enableTotp` replacing an existing enrolment needs a code from it | The owner can still reset someone else's, for a lost phone. |
| `pnpm db:seed-user … --set-password --enrol-totp` | This is how the first owner gets in. The password is prompted for, not typed on the command line; the TOTP secret is printed once. |
| Plan drift | `tablet_devices` is audited (A9 said it wasn't); its audit rows hold only the token's HMAC. `registered_by` is `created_by`. `switchUser` is part of `startSession`. |
| The backfill in 0022 | It was checked by hand on a scratch database before the migration was created: a document SUBMITTED before 0020 got its management step and could then be approved. It has no automated test, because the test databases start from all migrations. |
| Known limitations | **Lockout DoS (R11):** office sign-in can still be paused by a stranger for 15 minutes at a time. **Rule changes:** changing `approval_rules` while documents are waiting changes what "complete" means for their open round, so change the rules only when nothing is pending. **TOTP:** codes can be reused within their 30-second window. **Re-authentication:** changing your own PIN or password needs only a session. |

## Proof

| # | Command or test | Proves |
| --- | --- | --- |
| P1 | `pnpm lint && pnpm typecheck` | clean |
| P2 | `pnpm db:migrate`, `pnpm db:check` | migrations apply; append-only |
| P3 | `pnpm test`: `lib/auth/crypto.test.ts` | the RFC 6238 vectors; scrypt with pepper; AES-GCM round trip and tamper detection |
| P4 | `tests/db/approvals.db.test.ts` | **The engine:** a §6 rule creates its steps; steps are decided in order; the last approval sets APPROVED. **Who may decide:** the creator can't approve (AC3); a wrong role is refused; OWNER can approve. **Rejection:** needs a comment, returns the document to REJECTED, and resubmission starts round 2. **Database guarantees:** a direct status change to APPROVED is refused; decided rows are frozen; `decided_by` and `decided_at` are forced; the SATIS step-2 role follows the payment method; the queue is oldest first and leaves out the user's own documents. |
| P5 | `tests/db/auth.db.test.ts` | **PIN and password:** right and wrong guesses; 5 wrong in a row lock the account; the lock blocks sign-in until a manager unlocks it. **TOTP** is required for MANAGEMENT and OWNER. **Sessions:** a tablet session locks after 5 idle minutes (the clock is set from SQL); switching user ends the previous session; an ended or expired session is refused; tokens are stored only as hashes. **Credentials** never appear in `audit_log`. |
| P6 | `tests/db/permissions.db.test.ts` | Each §10 matrix row: allowed roles pass and others are refused. The job transitions follow §4's "who triggers"; LEGV is the formen's in QEBUL and management's after. |
| P7 | `tests/db/catalog.db.test.ts` | the new tables, grants and triggers, with the operational allowlist |
| P8 | `pnpm test:e2e` | sign-in with password and TOTP; the PIN switch on a tablet; idle lock; sign-out |
| P9 | the existing milestone 1 and 2 suites | still green, with approvals going through the engine |
