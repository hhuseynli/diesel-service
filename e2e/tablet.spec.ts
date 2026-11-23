// Plan 04, P-e2e: the formen's tablet in portrait (800x1280). A new car from intake to
// TEHVIL_VERILDI; the same car back again, found by its sticker code; a corporate car that
// is not on its client's contract, then found by its sticker while still in the workshop. Warehouse and approval steps have no screens yet
// (milestone 5), so the test takes them through lib as those staff.
import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../db/schema";
import { contragents, jobOrders, partsRequests, users } from "../db/schema";
import { withActor, withReason } from "../lib/audit";
import { registerTablet } from "../lib/auth";
import { createContract } from "../lib/contracts";
import { moveJob } from "../lib/jobs";
import az from "../messages/az.json" with { type: "json" };
import {
  E2E_DB,
  FORMEN,
  IDLE_SECONDS,
  MANAGER,
  MECHANIC,
  WAREHOUSE,
  withDatabase,
} from "./fixtures";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

const pool = new Pool({ connectionString: withDatabase(process.env.DATABASE_URL!, E2E_DB) });
const db = drizzle(pool, { schema });

let page: Page;
let managerId: string;
let warehouseId: string;
let jobId: string;
let stickerToken: string;
let corporateJobId: string;
let corporateSticker: string;

const vin = () =>
  `WDB9634031L${String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, "0")}`;
const photo = (name: string) => ({
  name: `${name}.jpg`,
  mimeType: "image/jpeg",
  buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(512)]),
});
const main = () => page.getByRole("main");

async function idleSeconds(seconds: number) {
  // The e2e database locks tablets after a few idle seconds (auth.spec); first page
  // compiles in dev take longer, so this spec runs with a longer timeout.
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

async function userId(phone: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone));
  return u!.id;
}

async function sign(where = main()) {
  const box = (await where.getByTestId("signature").boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 150, { steps: 8 });
  await page.mouse.move(box.x + 320, box.y + 70, { steps: 8 });
  await page.mouse.up();
}

/** The photo step: six photos and the odometer next to them (3.4), then "Davam et". */
async function takePhotos(km: string, reason?: string) {
  await expect(main().getByRole("heading", { level: 1 })).toHaveText(az.intake.photos);
  for (const [slot, label] of Object.entries(az.intake.slot)) {
    await page.getByLabel(label, { exact: true }).setInputFiles(photo(slot));
  }
  await page.getByLabel(az.intake.odometer).fill(km);
  if (reason) await page.getByLabel(az.intake.reason).fill(reason);
  await page.getByRole("button", { name: az.intake.continue }).click();
}

/** The last intake step: complaints, the driver's signature, "Saxla". */
async function fillAndSave() {
  await page.getByLabel(az.intake.complaints).fill("Əyləc pedalı yumşaqdır");
  await page.getByLabel(az.intake.mechanicOptional).selectOption({ label: MECHANIC.name });
  await page.getByLabel(az.intake.signerName).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
  await sign();
  await page.getByRole("button", { name: az.intake.save }).click();
}

async function photosAndSave(km: string) {
  await takePhotos(km);
  await fillAndSave();
  await expect(page).toHaveURL(/\/is\/[0-9a-f-]{36}\?yeni=1/);
}

async function findBySticker(token: string) {
  await page.goto("/qebul");
  await page.getByLabel(az.intake.qrCode).fill(token);
  await page
    .locator("form", { has: page.getByLabel(az.intake.qrCode) })
    .getByRole("button", { name: az.intake.find })
    .click();
  await expect(main().getByText(/VIN-in son 6 simvolunu/)).toBeVisible();
  await main().getByRole("link", { name: az.intake.vinMatches }).click();
}

async function newVehicle(make: string, plate: string) {
  await page.goto("/qebul");
  await page.getByLabel(az.intake.vin).fill(vin());
  await page
    .locator("form", { has: page.getByLabel(az.intake.vin) })
    .getByRole("button", { name: az.intake.find })
    .click();
  await expect(main().getByRole("heading", { level: 1 })).toHaveText(az.intake.newVehicle);
  await page.getByLabel(az.intake.make).fill(make);
  await page.getByLabel(az.intake.model).fill("Actros");
  await page.getByLabel(az.intake.plate).fill(plate);
  await page.getByRole("button", { name: az.intake.create }).click();
  await expect(main().getByRole("heading", { level: 1 })).toHaveText(az.intake.client);
}

const status = (s: keyof typeof az.status) =>
  expect(page.getByTestId("job-status")).toHaveText(az.status[s]);

// Serial, one signed-in tablet; dev compiles each screen on first visit, hence the timeout.
test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  await idleSeconds(600);
  managerId = await userId(MANAGER.phone);
  warehouseId = await userId(WAREHOUSE.phone);
  const deviceToken = await withActor(db, { userId: managerId }, (tx) =>
    registerTablet(tx, "E2E planşet"),
  );
  const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
  await context.addCookies([
    { name: "ds_device", value: deviceToken, domain: "localhost", path: "/" },
  ]);
  page = await context.newPage();
  await page.goto("/pin");
  await page.getByLabel(az.auth.who).selectOption({ label: FORMEN.name });
  await page.getByLabel(az.auth.pin).fill(FORMEN.pin);
  await page.getByRole("button", { name: az.auth.pin }).click();
  await expect(page.getByText(az.home.signedInAs.replace("{name}", FORMEN.name))).toBeVisible();
});

test.afterAll(async () => {
  await page?.context().close();
  await idleSeconds(IDLE_SECONDS);
  await pool.end();
});

test("a new car from intake to handover", async () => {
  await page.goto("/isler");
  await main().getByRole("link", { name: az.board.receive }).click();
  await newVehicle("Mercedes-Benz", "90-AB-123");

  await page.getByText(az.intake.newClient).click();
  await page.getByLabel(az.intake.name, { exact: true }).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.phone, { exact: true }).fill("+994551234567");
  await page.getByRole("button", { name: az.intake.create }).click();
  await photosAndSave("120000");

  jobId = page.url().match(/\/is\/([0-9a-f-]{36})/)![1]!;
  await expect(main().getByText(/İş sifarişi IS-\d{4}-\d{6} açıldı/)).toBeVisible();
  await status("QEBUL");

  // The new car's first sticker.
  await main().getByRole("link", { name: az.intake.printSticker }).click();
  await expect(page.getByTestId("sticker").locator("svg")).toBeVisible();
  stickerToken = page.url().split("/").pop()!;
  await page.goBack();

  // Inspection: a finding with a photo, a service and a part, then to the warehouse.
  await page.getByLabel(az.job.finding).fill("Ön əyləc diskləri yeyilib");
  await page
    .locator("form", { has: page.getByLabel(az.job.finding) })
    .getByLabel(az.job.mechanic)
    .selectOption({ label: MECHANIC.name });
  await page.getByLabel(az.job.findingPhotos).setInputFiles(photo("finding"));
  await page.getByRole("button", { name: az.job.addFinding }).click();
  await expect(main().getByText("Ön əyləc diskləri yeyilib")).toBeVisible();
  await expect(main().getByRole("img", { name: az.job.findingPhotos })).toBeVisible();
  await page.getByLabel(az.job.service).fill("Ön əyləc disklərinin dəyişdirilməsi");
  await page.getByRole("button", { name: az.job.addService }).click();
  await page.getByLabel(az.job.part).fill("Əyləc diski");
  await page.getByRole("button", { name: az.job.addPart }).click();
  await expect(main().getByText(/Əyləc diski — 1/)).toBeVisible();
  await page.getByRole("button", { name: az.job.sendToWarehouse }).click();
  await expect(page).toHaveURL(/\/isler$/);
  await expect(
    main().getByRole("region", { name: az.status.BAXIS }).getByTestId("job-card"),
  ).toHaveCount(1);

  // Warehouse prices it and the client approves (milestone 5 and 6 screens).
  await withActor(db, { userId: warehouseId }, async (tx) => {
    await withReason(tx, "e2e: anbarda var", () =>
      tx
        .update(partsRequests)
        .set({ status: "CANCELLED" })
        .where(eq(partsRequests.jobOrderId, jobId)),
    );
    await moveJob(tx, jobId, "QIYMETLENDIRME", "e2e");
    await moveJob(tx, jobId, "TESDIQ_GOZLEYIR", "e2e");
  });
  await withActor(db, { userId: managerId }, (tx) => moveJob(tx, jobId, "TESDIQLENDI", "e2e"));

  // Work, the old part, the quality check.
  await page.goto(`/is/${jobId}`);
  await page.getByRole("button", { name: az.job.startWork }).click();
  await status("TEMIRDE");
  await page.getByLabel(az.job.removedPart).fill("Köhnə əyləc diski");
  await page.getByLabel(az.intake.takePhoto).setInputFiles(photo("removed"));
  await page.getByRole("button", { name: az.job.addRemovedPart }).click();
  await expect(main().getByText(/Köhnə əyləc diski — /)).toBeVisible();
  for (const label of Object.values(az.job.check)) await page.getByLabel(label).check();
  await page.getByLabel(az.job.dashboardPhoto).setInputFiles(photo("dashboard"));
  await page.getByRole("button", { name: az.job.submitCheck }).click();
  await status("HAZIR");

  // Handover with the collector's signature.
  await page.getByLabel(az.intake.signerName).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
  await sign();
  await page.getByRole("button", { name: az.job.handOver }).click();
  await expect(page).toHaveURL(/\/isler$/);
  await page.goto(`/is/${jobId}`);
  await status("TEHVIL_VERILDI");
  await expect(main().getByText(az.job.waitingPayment)).toBeVisible();
});

test("the car returns: found by its sticker, last client offered, lower odometer needs a reason", async () => {
  // Handed over, the car has left the workshop: its unpaid job does not block a new visit.
  await findBySticker(stickerToken);
  await expect(main().getByText(/Son ziyarətdəki müştəri: Əli Məmmədov/)).toBeVisible();
  await main().getByRole("link", { name: az.intake.choose }).click();
  await expect(main().getByText(/Əvvəlki yürüş: 120 000 km/)).toBeVisible();
  // Lower than last time: refused on the photo step, before anything is uploaded.
  await takePhotos("110000");
  await expect(main().getByRole("alert")).toHaveText(az.errors.odometerReason);
  await takePhotos("110000", "Panel dəyişdirilib");
  await fillAndSave();
  await expect(page).toHaveURL(/\/is\/[0-9a-f-]{36}\?yeni=1&od=1/);
  await expect(main().getByRole("alert")).toHaveText(az.job.odometerFlagged);
});

test("the plate is a shortcut that still leads through the VIN", async () => {
  await page.goto("/qebul");
  await page.getByLabel(az.intake.plateSearch).fill("90 ab 123");
  await page
    .locator("form", { has: page.getByLabel(az.intake.plateSearch) })
    .getByRole("button", { name: az.intake.find })
    .click();
  await main()
    .getByRole("link", { name: /90-AB-123 \(cari nömrə\)/ })
    .click();
  await expect(main().getByText(/VIN-in son 6 simvolunu/)).toBeVisible();
});

test("a corporate car not on its client's contract needs the formen's decision", async () => {
  await withActor(db, { userId: managerId }, async (tx) => {
    const [company] = await tx
      .insert(contragents)
      .values({ kind: "HUQUQI", name: "E2E Korporativ MMC", voen: "1234567891", isCustomer: true })
      .returning({ id: contragents.id });
    const { rows } = await tx.execute<{ today: string }>(sql`SELECT baku_date()::text AS today`);
    await createContract(tx, {
      contragentId: company!.id,
      number: "E2E-1",
      signedOn: rows[0]!.today,
      validFrom: rows[0]!.today,
    });
  });

  await newVehicle("MAN", "10-KK-777");
  await page.getByLabel(az.intake.clientSearch).fill("Korporativ");
  await page.getByRole("button", { name: az.intake.find }).click();
  await main()
    .getByRole("link", { name: /E2E Korporativ MMC/ })
    .click();
  await expect(main().getByRole("heading", { level: 1 })).toHaveText(az.intake.notOnContract);
  await main().getByRole("link", { name: az.intake.separatePaid }).click();
  await photosAndSave("54000");

  const id = page.url().match(/\/is\/([0-9a-f-]{36})/)![1]!;
  const [job] = await db
    .select({ check: jobOrders.contractCheck, decision: jobOrders.contractDecision })
    .from(jobOrders)
    .where(eq(jobOrders.id, id));
  expect(job).toEqual({ check: "NOT_ON_CONTRACT", decision: "SEPARATE_PAID" });
  corporateJobId = id;
  await main().getByRole("link", { name: az.intake.printSticker }).click();
  await expect(page.getByTestId("sticker").locator("svg")).toBeVisible();
  corporateSticker = page.url().split("/").pop()!;
});

test("a car still in the workshop leads to its open job", async () => {
  await findBySticker(corporateSticker);
  await expect(main().getByText(az.intake.openJobExists)).toBeVisible();
  await main().getByRole("link", { name: az.intake.openJobLink }).click();
  await expect(page).toHaveURL(new RegExp(`/is/${corporateJobId}$`));
});
