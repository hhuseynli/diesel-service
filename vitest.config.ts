import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "node_modules/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          // Real Postgres, never mocks. Each file gets its own database copied
          // from a migrated template (plan 01, "Options not chosen").
          name: "db",
          include: ["tests/db/**/*.db.test.ts"],
          globalSetup: ["tests/db/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
