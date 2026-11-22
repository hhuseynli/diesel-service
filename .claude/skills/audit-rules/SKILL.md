---
name: audit-rules
description: Apply the audit and immutability rules. Use whenever creating or
  changing a database table, migration, server action, API route or domain
  function that writes data, or when reviewing such code.
---
# Audit rules

Source: spec/00-backbone.md sections 5 and 3a. Risks: R4, R5, R6, R11.

When you write or change anything that stores data:

1. **No deletes.** Never write `DELETE` or `TRUNCATE` for business tables.
   To cancel, set `status = 'ANNULLED'` and require `annul_reason`.
2. **Audit row on every write.** Inserts and updates on business tables go
   through the `audited()` helper in `lib/audit`, or the table has the
   `audit_trigger`. New tables must be added to the trigger list in a
   migration.
3. **Locked documents.** Rows in `documents` with status `APPROVED` or
   `POSTED` must not be updated. The `lock_approved_documents` trigger
   rejects it; do not work around it. Corrections: create a new version
   with `supersedes_id`, or a reversing document.
4. **Reasons.** Any correction, price change or discount takes a non-empty
   `reason`. Price changes also need the `change_price` permission.
5. **Server time.** Columns like `created_at`, `approved_at` default to
   `now()`. Never accept a timestamp for a recorded event from the client.
6. **Actor.** Every write records the user who unlocked the session
   (`ctx.userId`). Never a shared or system user for human actions.
7. **Permissions.** The app's database role has no UPDATE or DELETE on
   `audit_log` and `attachments`. Migrations must keep it that way.

Every change that writes data needs a database test proving:
- the audit row exists with before, after, user and reason;
- an update to an approved document fails;
- a delete attempt fails.
