# Highest Service operations system

Built with the AI-native SDLC: intent → spec → plan → code, each committed
before the next starts.

## Repository map
| Path | What | Who edits |
| --- | --- | --- |
| `intent/` | What and why, per module | Aykhan + owner |
| `spec/` | Requirements and design | Aykhan (with Claude), reviewed |
| `RISKS.md` | Risk register (R1...) | Aykhan |
| `plan/` | Approved implementation plans | Claude in plan mode, accepted by Aykhan |
| `CLAUDE.md` | Context Claude reads every session | Whole team; add a line when Claude repeats a mistake |
| `.claude/skills/` | Rules applied automatically | Aykhan |
| `.claude/hooks/` | Hard blocks on dangerous actions | Aykhan only |
| `.claude/agents/` | verifier, spec-checker subagents | Aykhan |
| `REVIEW.md` | Instructions for Claude PR review | Aykhan |
| `prompts/` | Kickoff prompts for plan mode | Aykhan |

## One-time setup
1. Create a private GitHub repo and push this folder.
2. Install: Node 22, pnpm, Docker, jq (the hooks fail closed without it),
   Claude Code.
3. Make hooks executable: `chmod +x .claude/hooks/*.sh`.
4. In Claude Code, run `/hooks` to confirm the three hooks are loaded.
5. Protect `main`: require a pull request and your approval to merge.
6. Optional: enable Claude Code Review or the claude-code-action on the
   repo; it reads REVIEW.md.

## Local development
Node 22 is pinned in `.npmrc` (pnpm downloads it), so `pnpm` commands run on
22 even if your default Node is newer.

1. Create `.env.example` (see plan/01-foundations.md; Claude cannot write
   `.env*` files), then `cp .env.example .env`.
2. `pnpm install`, then `pnpm exec playwright install chromium`.
3. `docker compose up -d db`. Postgres 16 listens on **localhost:5433**
   (5432 is often taken by a local Postgres). On first start it creates the
   roles `diesel_migrator` (owns the schema, runs migrations) and
   `diesel_app` (the only role the app uses; no DELETE anywhere).
4. `pnpm db:migrate`, then `pnpm dev`.

Checks: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm db:check`,
and `pnpm test:e2e`. Database tests copy a migrated template database per
test file and never mock Postgres.

Staff accounts before user management exists (milestone 3):
`pnpm db:seed-user --name "<full name>" --phone +994XXXXXXXXX --role CASHIER`.
Personal data goes on the command line only, never into git.

## Production database bootstrap
Run once, as an administrator of the managed Postgres, before the first
`pnpm db:migrate` (the same as `docker/initdb/01-roles.sh`, without CREATEDB):

```sql
CREATE ROLE diesel_migrator LOGIN PASSWORD '<secret>';
CREATE ROLE diesel_app LOGIN NOINHERIT PASSWORD '<secret>';
CREATE DATABASE diesel OWNER diesel_migrator;
REVOKE ALL ON DATABASE diesel FROM PUBLIC;
GRANT CONNECT ON DATABASE diesel TO diesel_app;
```

The app connects as `diesel_app` (DATABASE_URL); migrations run as
`diesel_migrator` (MIGRATION_DATABASE_URL). Every other privilege comes from
the migrations.

## Then
Follow `prompts/01-plan-milestone-1.md`.

## What the hooks block
- Edits to intent/, spec/, RISKS.md, .env, hooks and settings.
- Edits to migrations that already exist.
- Shell commands with DROP, TRUNCATE, DELETE FROM, push to main,
  force-push, --no-verify, production deploys, or redirects into
  protected paths.

Hooks guard Claude's tools, not the files themselves. The real guarantees
(no deletes, locked documents, append-only audit) live in the database, so
they hold even if a hook is bypassed.
