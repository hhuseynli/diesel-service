# Review instructions

## Passes
Tag each finding with its pass:
- Bugs: logic errors, edge cases, race conditions (numbering, stock).
- Integrity: deletes, updates to approved documents, client-supplied
  timestamps, missing audit rows, plate used as identity, money as float.
- Security: missing permission checks, creator approving own document,
  personal data in logs, one owner seeing another owner's vehicle history.
- Compliance: the change matches spec/ and plan/; risks in RISKS.md are
  handled as the spec says.

## What Important means here
Important = breaks behavior, loses or falsifies data, leaks personal data,
or breaks an audit rule. Everything else is a nit.

## Cap the nits
At most five nits per review; summarize the rest as a count.

## Do not report
Generated files under db/migrations/meta/, formatting handled by Prettier.
