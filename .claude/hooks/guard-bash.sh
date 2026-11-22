#!/bin/bash
# Blocks shell commands that destroy data, bypass history, or reach production.
if ! command -v jq >/dev/null 2>&1; then
  echo "Blocked: jq is not installed, so this safety hook cannot run. Install jq first." >&2
  exit 2
fi
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0
UPPER=$(echo "$CMD" | tr '[:lower:]' '[:upper:]')

block() { echo "Blocked: $1" >&2; exit 2; }

[[ "$UPPER" == *"DROP TABLE"* || "$UPPER" == *"DROP DATABASE"* || "$UPPER" == *"TRUNCATE"* ]] \
  && block "destructive SQL. Schema changes go through a new migration."
[[ "$UPPER" == *"DELETE FROM"* ]] \
  && block "DELETE is not used in this system (records are annulled, never deleted)."
[[ "$CMD" == *"git push"*"main"* || "$CMD" == *"git push --force"* || "$CMD" == *"git push -f"* ]] \
  && block "pushing to main or force-pushing. Open a PR instead."
[[ "$CMD" == *"--no-verify"* ]] && block "skipping git hooks."
[[ "$CMD" == *"deploy"* && "$CMD" == *"prod"* ]] \
  && block "production deploys need a human release approval."
[[ "$CMD" =~ (^|[[:space:]])(cat|sed|tee|echo|printf|cp|mv)[[:space:]].*(intent/|spec/|RISKS\.md|db/migrations/) && "$CMD" == *">"* ]] \
  && block "writing to protected paths through the shell."
exit 0
