# Plan mode kickoff: milestone 1 (foundations)

Start Claude Code in plan mode (Shift+Tab until "plan mode") and paste:

---
Read CLAUDE.md, spec/00-backbone.md (sections 2, 3, 3a, 5, 7, 10 and 13)
and RISKS.md. We are building milestone 1 only: the project foundation and
the database guarantees everything else depends on. No screens yet.

Milestone 1 scope:
1. Project setup: Next.js + TypeScript, pnpm, Drizzle with SQL migrations,
   Postgres in docker compose, Vitest (unit + database tests against real
   Postgres), Playwright installed, ESLint, Prettier, and the commands
   listed in CLAUDE.md.
2. Database roles: a migration role and an app role. The app role has no
   UPDATE or DELETE on audit_log and attachments, and no DELETE anywhere.
3. Core tables: settings, users, user_roles, contragents, vehicles,
   vehicle_plates (with the constraints in section 3a), documents,
   document_lines, document_counters, audit_log, attachments.
4. Triggers: audit trigger on business tables; lock on approved/posted
   documents.
5. lib/numbering with assignNumber(), lib/money, lib/audit.
6. Database tests for spec 00 acceptance criteria 2, 4, 7, 8 and 9, plus
   the numbering tests in the document-numbering skill.

Write the plan to plan/01-foundations.md with: files that change, order of
work, risks (what could break, which step is riskiest, options you did not
choose and why), and a Proof section listing the exact tests and commands
that prove each item. Ask me questions wherever the spec is ambiguous
instead of guessing. Flag anything in the spec you think is wrong.
---

Before accepting the plan, ask Claude:
- What could this break later, when the warehouse and accounting modules
  arrive?
- Which step is riskiest, and how will we know it works?
- Could an engineer who never saw this conversation implement it from
  plan/01-foundations.md alone?

Commit the accepted plan, then let Claude implement. Run the verifier
subagent before opening the PR.

## Later milestones (one plan each)
2. Job orders, lifecycle state machine, contracts and contract vehicles.
3. Approval engine and permissions (section 6 and 10), PIN switching.
4. Formen tablet screens (spec 01), thin version end to end.
5. Warehouse screens (spec 02), thin version end to end.
6. Notifications (email), PDF documents, catalog import from 1C.
Then: deepen each module, then accounting specs.
