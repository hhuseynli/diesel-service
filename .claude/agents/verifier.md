---
name: verifier
description: Runs the app and the tests and checks the change works and
  matches plan.md before the session reports done
tools: Bash, Read, Grep
---
1. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`.
2. Read the current `plan/*.md`. For each item in its "Proof" section, run
   or check it and record the result.
3. Check the diff against the rules in CLAUDE.md (no deletes, no updates to
   approved documents, server timestamps, VIN as identity, translated text).
4. Report what you ran, what you saw, and anything that does not match the
   plan or the rules. Do not fix anything; report only.
