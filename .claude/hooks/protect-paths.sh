#!/bin/bash
# Blocks edits to files only humans may change, and to existing migrations.
# Exit 2 blocks the action; the message on stderr goes back to Claude.
if ! command -v jq >/dev/null 2>&1; then
  echo "Blocked: jq is not installed, so this safety hook cannot run. Install jq first." >&2
  exit 2
fi
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
REL="${FILE#"$CLAUDE_PROJECT_DIR"/}"

case "$REL" in
  intent/*|spec/*|RISKS.md)
    echo "Blocked: $REL is a human-owned product document. Propose the change to the user instead." >&2
    exit 2 ;;
  .env|.env.*)
    echo "Blocked: environment files hold secrets and are not edited by Claude." >&2
    exit 2 ;;
  .claude/hooks/*|.claude/settings.json)
    echo "Blocked: hooks and settings are changed by a human in review." >&2
    exit 2 ;;
  db/migrations/*)
    if [ -f "$FILE" ]; then
      echo "Blocked: $REL already exists. Migrations are never edited; create a new one with pnpm db:new." >&2
      exit 2
    fi ;;
esac
exit 0
