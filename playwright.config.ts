import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";
import { E2E_DB, withDatabase } from "./e2e/fixtures";

const port = 3100;
const appUrl = process.env.DATABASE_URL ?? "";

export default defineConfig({
  testDir: "e2e",
  // The sign-in tests share one database and one server; run them in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: `http://localhost:${port}`, locale: "az-AZ", timezoneId: "Asia/Baku" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A fresh e2e database every run, then the app against it.
    command: `pnpm exec tsx e2e/prepare-db.ts && pnpm exec next dev --port ${port}`,
    url: `http://localhost:${port}/giris`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL: appUrl ? withDatabase(appUrl, E2E_DB) : "" },
  },
});
