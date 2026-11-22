// pnpm db:new <name>                 -> migration generated from the db/schema diff
// pnpm db:new <name> --from <file>   -> custom SQL migration with the content of <file>
//
// Migrations are never edited once created (CLAUDE.md). The --from form exists because
// drizzle-kit creates custom migrations as empty files, and an existing migration file
// must not be written to afterwards. Drafts live in db/drafts/ (gitignored).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = "db/migrations";
const JOURNAL = path.join(MIGRATIONS_DIR, "meta/_journal.json");
// drizzle-kit writes this line into a new custom migration.
const CUSTOM_PLACEHOLDER = /^\s*-- Custom SQL migration file, put your code below! --\s*$/;

function fail(message: string): never {
  console.error(`db:new: ${message}`);
  process.exit(1);
}

function journalTags(): string[] {
  try {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: { tag: string }[] };
    return journal.entries.map((e) => e.tag);
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const name = args[0];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  fail("usage: pnpm db:new <snake_case_name> [--from <draft.sql>]");
}
const fromIndex = args.indexOf("--from");
const draftPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
if (fromIndex >= 0 && !draftPath) fail("--from needs a file path");

let draft: string | undefined;
if (draftPath) {
  draft = readFileSync(draftPath, "utf8");
  if (draft.trim() === "") fail(`${draftPath} is empty`);
}

const before = journalTags();
const kitArgs = ["exec", "drizzle-kit", "generate", `--name=${name}`];
if (draft) kitArgs.push("--custom");
const result = spawnSync("pnpm", kitArgs, { stdio: "inherit" });
if (result.status !== 0) fail("drizzle-kit generate failed");

const after = journalTags();
if (after.length !== before.length + 1) {
  fail(draft ? "drizzle-kit did not create a migration" : "no schema changes, nothing generated");
}
const file = path.join(MIGRATIONS_DIR, `${after[after.length - 1]}.sql`);

if (draft) {
  const existing = readFileSync(file, "utf8");
  if (existing.trim() !== "" && !CUSTOM_PLACEHOLDER.test(existing)) {
    fail(`${file} is not a fresh custom migration; refusing to write to it`);
  }
  writeFileSync(file, draft.endsWith("\n") ? draft : `${draft}\n`);
}
console.log(`db:new: created ${file}`);
