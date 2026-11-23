// Shared steps for the tablet e2e specs: a signed-in tablet, and the formen's common
// moves through the screens (design canvas "Planşet (formen)").
import { randomBytes } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../db/schema";
import { users } from "../db/schema";
import { withActor } from "../lib/audit";
import { registerTablet } from "../lib/auth";
import az from "../messages/az.json" with { type: "json" };
import { E2E_DB, FORMEN, MANAGER, withDatabase } from "./fixtures";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

// One pool for both tablet specs; the worker ends with the run.
const pool = new Pool({
  connectionString: withDatabase(process.env.DATABASE_URL!, E2E_DB),
});
export const db = drizzle(pool, { schema });

export async function userId(phone: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone));
  return u!.id;
}

/**
 * The e2e database locks tablets after a few idle seconds (auth.spec); first page compiles
 * in dev take longer, so the tablet specs run with a longer timeout and put it back after.
 */
export async function idleSeconds(seconds: number) {
  const client = new Client({
    connectionString: withDatabase(process.env.MIGRATION_DATABASE_URL!, E2E_DB),
  });
  await client.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.user_id', $1, true), set_config('app.reason', 'e2e', true)",
    [SYSTEM_USER_ID],
  );
  await client.query("INSERT INTO settings (key, value) VALUES ('tablet_idle_seconds', $1)", [
    JSON.stringify(seconds),
  ]);
  await client.query("COMMIT");
  await client.end();
}

/** A browser registered as the shared tablet, the formen signed in by PIN, on the board. */
export async function signedInTablet(browser: Browser): Promise<Page> {
  const managerId = await userId(MANAGER.phone);
  const deviceToken = await withActor(db, { userId: managerId }, (tx) =>
    registerTablet(tx, "E2E planşet"),
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([
    { name: "ds_device", value: deviceToken, domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();
  await page.goto("/pin");
  await page.getByRole("link", { name: new RegExp(FORMEN.name) }).click();
  const keypad = page.getByTestId("keypad");
  for (const digit of FORMEN.pin) {
    await keypad.getByRole("button", { name: digit, exact: true }).click();
  }
  await keypad.getByRole("button", { name: az.auth.signInPin }).click();
  await expect(page).toHaveURL(/\/isler$/);
  return page;
}

export const vin = () =>
  `WDB9634031L${String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, "0")}`;

export const photo = (name: string) => ({
  name: `${name}.jpg`,
  mimeType: "image/jpeg",
  buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(512)]),
});

/** The formen's moves, on one page. */
export function tablet(page: Page) {
  const main = () => page.getByRole("main");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const link = (name: string) => page.getByRole("link", { name, exact: true });

  async function sign() {
    const box = (await page.getByTestId("signature").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
    await page.mouse.move(box.x + 320, box.y + 70, { steps: 8 });
    await page.mouse.up();
  }

  return {
    main,
    button,
    link,
    sign,
    status: (s: keyof typeof az.status) =>
      expect(page.getByTestId("job-status")).toHaveText(az.status[s]),
    jobIdFromUrl: () => page.url().match(/\/is\/([0-9a-f-]{36})/)![1]!,

    /** 2.1 → 2.3: a VIN the system does not know, then the car's details. */
    async newVehicle(make: string, plate: string) {
      await page.goto("/qebul");
      await link(az.intake.mode.vin).click();
      await page.getByLabel(az.intake.searchVin, { exact: true }).fill(vin());
      await button(az.intake.find).click();
      await expect(page.getByRole("heading", { name: az.intake.newVehicle })).toBeVisible();
      await page.getByLabel(az.intake.make, { exact: true }).fill(make);
      await page.getByLabel(az.intake.model, { exact: true }).fill("Actros");
      await page.getByLabel(az.intake.plate, { exact: true }).fill(plate);
      await button(az.ui.continue).click();
      await expect(page.getByRole("heading", { name: az.intake.clientTitle })).toBeVisible();
    },

    /** 3.1: a new individual client. */
    async newPerson(name: string) {
      await link(az.intake.newClient).click();
      await page.getByLabel(az.intake.name, { exact: true }).fill(name);
      await page.getByLabel(az.intake.phone, { exact: true }).fill("+994551234567");
      await button(az.intake.createClient).click();
      await expect(page.getByTestId("selected-client")).toContainText(name);
    },

    /** 3.2 Foto və yürüş: six tiles and the odometer, then "Davam et". */
    async takePhotos(km: string, reason?: string) {
      await expect(page.getByRole("heading", { name: az.intake.photosTitle })).toBeVisible();
      for (const [slot, label] of Object.entries(az.intake.slot)) {
        await page.getByLabel(label, { exact: true }).setInputFiles(photo(slot));
      }
      await page.getByLabel(az.intake.kmLabel).fill(km);
      if (reason) await page.getByLabel(az.intake.reasonRequired).fill(reason);
      await button(az.ui.continue).click();
    },

    /** 3.3 Şikayət və imza: the complaint, the driver's signature, "Saxla". */
    async complaintsAndSave() {
      await page.getByLabel(az.intake.complaint).fill("Əyləc pedalı yumşaqdır");
      await page.getByLabel(az.intake.signerName, { exact: true }).fill("Əli Məmmədov");
      await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
      await sign();
      await button(az.intake.saveOpen).click();
      await expect(page).toHaveURL(/\/is\/[0-9a-f-]{36}\?yeni=1/);
    },

    /** 2.1 → 2.2: find a car by its sticker code and confirm its VIN. */
    async findBySticker(token: string, confirm = true) {
      await page.goto("/qebul");
      await page.getByLabel(az.intake.searchCode, { exact: true }).fill(token);
      await button(az.intake.find).click();
      await expect(page.getByRole("heading", { name: az.intake.vinCheckHeading })).toBeVisible();
      if (confirm) await link(az.intake.vinMatches).click();
    },

    /** The new car's first sticker, from the job card after "Saxla". */
    async printSticker() {
      await link(az.job.printSticker).click();
      await expect(page.getByTestId("sticker").locator("svg")).toBeVisible();
      return new URL(page.url()).pathname.split("/").pop()!;
    },

    /** 4.1: a finding with a photo; optionally its service and a part. */
    async addFinding(text: string, extra: { service?: string; part?: string } = {}) {
      await page.getByLabel(az.job.what).fill(text);
      await page.getByLabel(az.job.mediaTile, { exact: true }).setInputFiles(photo("finding"));
      if (extra.service) await page.getByLabel(az.job.service).fill(extra.service);
      if (extra.part) await page.getByLabel(az.job.part, { exact: true }).fill(extra.part);
      await button(az.ui.save).click();
      await expect(page).toHaveURL(/\/is\/[0-9a-f-]{36}$/);
      await expect(main().getByText(text)).toBeVisible();
    },
  };
}
