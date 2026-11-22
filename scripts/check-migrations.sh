#!/bin/bash
# pnpm db:check [base-ref]
# 1. Migrations are append-only: no existing db/migrations/*.sql may be modified,
#    renamed or deleted, compared with the base branch or in the working tree.
# 2. drizzle-kit's own consistency check of the migration snapshots.
# 3. db/schema matches the migrations: generating from the schema produces nothing new.
set -euo pipefail
cd "$(dirname "$0")/.."

base="${1:-origin/main}"
git rev-parse --verify -q "$base" >/dev/null || base=main

changed=$(
  {
    git diff --name-only --diff-filter=MDR "$base"...HEAD -- 'db/migrations/*.sql'
    git diff --name-only --diff-filter=MDR HEAD -- 'db/migrations/*.sql'
  } | sort -u
)
if [ -n "$changed" ]; then
  echo "db:check: existing migrations were changed (create a new migration instead):" >&2
  echo "$changed" >&2
  exit 1
fi
echo "db:check: migrations are append-only (compared with $base)"

pnpm exec drizzle-kit check

# drizzle-kit only accepts a relative output folder.
tmp="node_modules/.cache/db-check"
rm -rf "$tmp"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
cp -R db/migrations/. "$tmp"
count_before=$(find "$tmp" -maxdepth 1 -name '*.sql' | wc -l)
if ! output=$(pnpm exec drizzle-kit generate --dialect=postgresql --schema=./db/schema/index.ts \
  --out="./$tmp" --name=drift_check 2>&1) || grep -q "Error" <<<"$output"; then
  echo "$output" >&2
  echo "db:check: could not compare db/schema with the migrations" >&2
  exit 1
fi
count_after=$(find "$tmp" -maxdepth 1 -name '*.sql' | wc -l)
if [ "$count_after" -ne "$count_before" ]; then
  echo "db:check: db/schema has changes without a migration; run pnpm db:new <name>" >&2
  exit 1
fi
echo "db:check: db/schema matches the migrations"
