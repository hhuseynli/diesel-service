---
name: document-numbering
description: Rules for numbering documents. Use whenever creating a new
  document type, submitting or approving a document, or touching
  lib/numbering or the document_counters table.
---
# Document numbering

Source: spec/00-backbone.md section 7.

- Format: `<PREFIX>-<YEAR>-<6 digits>`, e.g. `QA-2026-000123`. Prefixes
  live in `lib/numbering/prefixes.ts`; a new document type needs one.
- Numbers are assigned only by `assignNumber(tx, docType)` inside the same
  transaction that moves the document out of draft. It locks the row in
  `document_counters` (`SELECT ... FOR UPDATE`).
- Never use Postgres sequences or `max(number)+1` for document numbers:
  sequences skip on rollback, and max+1 races.
- Drafts have no number. A numbered document is never deleted and its
  number never reused; annulled documents keep their number.
- Year is the Asia/Baku calendar year of the database time at submission.

Tests required for any change here:
- 50 concurrent submissions produce 50 consecutive numbers, no gaps, no
  duplicates.
- A rolled-back transaction does not consume a number.
