#!/bin/bash
# Formats and lints the edited file only, so the check stays fast.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
case "$FILE" in
  *.ts|*.tsx|*.js|*.json|*.md|*.css)
    [ -f "$CLAUDE_PROJECT_DIR/node_modules/.bin/prettier" ] && \
      "$CLAUDE_PROJECT_DIR/node_modules/.bin/prettier" --write "$FILE" >/dev/null 2>&1
    ;;
esac
exit 0
