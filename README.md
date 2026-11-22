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
