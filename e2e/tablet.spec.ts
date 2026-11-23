// Plan 04, P-e2e: the formen's tablet, landscape 1280x800 (design canvas "Planşet
// (formen)"). A new car from intake to TEHVIL_VERILDI; the same car back again, found by
// its sticker code; the plate shortcut; a corporate car not on its client's contract, then
// found by its sticker while still in the workshop. Warehouse and approval steps have no
// screens yet (milestone 5), so the test takes them through lib as those staff.
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
import { E2E_DB, FORMEN, IDLE_SECONDS, MANAGER, WAREHOUSE, withDatabase } from "./fixtures";

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
const button = (name: string) => page.getByRole("button", { name, exact: true });
const link = (name: string) => page.getByRole("link", { name, exact: true });

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

async function sign() {
  const box = (await page.getByTestId("signature").boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
  await page.mouse.move(box.x + 320, box.y + 70, { steps: 8 });
  await page.mouse.up();
}

const status = (s: keyof typeof az.status) =>
  expect(page.getByTestId("job-status")).toHaveText(az.status[s]);

/** 2.1 → 2.3: a VIN the system does not know, then the car's details. */
async function newVehicle(make: string, plate: string) {
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
}

/** 3.2 Foto və yürüş: six tiles and the odometer, then "Davam et". */
async function takePhotos(km: string, reason?: string) {
  await expect(page.getByRole("heading", { name: az.intake.photosTitle })).toBeVisible();
  for (const [slot, label] of Object.entries(az.intake.slot)) {
    await page.getByLabel(label, { exact: true }).setInputFiles(photo(slot));
  }
  await page.getByLabel(az.intake.kmLabel).fill(km);
  if (reason) await page.getByLabel(az.intake.reasonRequired).fill(reason);
  await button(az.ui.continue).click();
}

/** 3.3 Şikayət və imza: the complaint, the driver's signature, "Saxla". */
async function complaintsAndSave() {
  await page.getByLabel(az.intake.complaint).fill("Əyləc pedalı yumşaqdır");
  await page.getByLabel(az.intake.signerName, { exact: true }).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
  await sign();
  await button(az.intake.saveOpen).click();
  await expect(page).toHaveURL(/\/is\/[0-9a-f-]{36}\?yeni=1/);
}

async function findBySticker(token: string) {
  await page.goto("/qebul");
  await page.getByLabel(az.intake.searchCode, { exact: true }).fill(token);
  await button(az.intake.find).click();
  await expect(page.getByRole("heading", { name: az.intake.vinCheckHeading })).toBeVisible();
  await link(az.intake.vinMatches).click();
}

async function printSticker() {
  await link(az.job.printSticker).click();
  await expect(page.getByTestId("sticker").locator("svg")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

// Serial, one signed-in tablet; dev compiles each screen on first visit, hence the timeout.
test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  await idleSeconds(600);
  managerId = await userId(MANAGER.phone);
  warehouseId = await userId(WAREHOUSE.phone);
  const deviceToken = await withActor(db, { userId: managerId }, (tx) =>
    registerTablet(tx, "E2E planşet"),
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([
    { name: "ds_device", value: deviceToken, domain: "localhost", path: "/" },
  ]);
  page = await context.newPage();
  await page.goto("/pin");
  await page.getByRole("link", { name: new RegExp(FORMEN.name) }).click();
  const keypad = page.getByTestId("keypad");
  for (const digit of FORMEN.pin) {
    await keypad.getByRole("button", { name: digit, exact: true }).click();
  }
  await keypad.getByRole("button", { name: az.auth.signInPin }).click();
  await expect(page).toHaveURL(/\/isler$/);
});

test.afterAll(async () => {
  await page?.context().close();
  await idleSeconds(IDLE_SECONDS);
  await pool.end();
});

test("a new car from intake to handover", async () => {
  await link(az.board.receive).click();
  await newVehicle("Mercedes-Benz", "90-AB-123");

  // A new car has no last client: create one; an individual is not checked against contracts.
  await link(az.intake.newClient).click();
  await page.getByLabel(az.intake.name, { exact: true }).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.phone, { exact: true }).fill("+994551234567");
  await button(az.intake.createClient).click();
  await expect(page.getByTestId("selected-client")).toContainText("Əli Məmmədov");
  await link(az.ui.continue).click();
  await takePhotos("120000");
  await complaintsAndSave();

  jobId = page.url().match(/\/is\/([0-9a-f-]{36})/)![1]!;
  await expect(main().getByText(/İş sifarişi IS-\d{4}-\d{6} açıldı/)).toBeVisible();
  await status("QEBUL");
  stickerToken = await printSticker();
  await page.goto(`/is/${jobId}`);

  // 4.1 Inspection: a finding with a photo, its service and a part, in one form.
  await link(az.job.addFinding).click();
  await page.getByLabel(az.job.what).fill("Ön əyləc diskləri yeyilib");
  await page.getByLabel(az.job.mediaTile, { exact: true }).setInputFiles(photo("finding"));
  await page.getByLabel(az.job.service).fill("Ön əyləc disklərinin dəyişdirilməsi");
  await page.getByLabel(az.job.part, { exact: true }).fill("Əyləc diski");
  await button(az.ui.save).click();
  await expect(page).toHaveURL(new RegExp(`/is/${jobId}$`));
  await expect(main().getByText("Ön əyləc diskləri yeyilib")).toBeVisible();
  await expect(main().getByRole("img", { name: az.job.media })).toBeVisible();
  await expect(main().getByText("Əyləc diski", { exact: true })).toBeVisible();
  await button(az.job.sendToWarehouse).click();
  await expect(page).toHaveURL(/\/isler$/);
  await expect(
    main().getByRole("region", { name: az.board.lanes.office }).getByTestId("job-card"),
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

  // 5.x Work, the old part, the quality check.
  await page.goto(`/is/${jobId}`);
  await button(az.job.startWork).click();
  await status("TEMIRDE");
  await link(az.job.removedPart).click();
  await page.getByLabel(az.job.otherPartName).fill("Köhnə əyləc diski");
  await page.getByLabel(az.job.removedPhoto, { exact: true }).setInputFiles(photo("removed"));
  await button(az.ui.save).click();
  await expect(main().getByText("Köhnə əyləc diski")).toBeVisible();
  await link(az.job.qualityCheck).click();
  for (const label of Object.values(az.job.check)) await page.getByLabel(label).check();
  await page.getByLabel(az.job.dashboardPhoto, { exact: true }).setInputFiles(photo("dashboard"));
  await button(az.job.qcPass).click();
  await status("HAZIR");

  // 6.1 Handover with the collector's signature.
  await link(az.job.handOver).click();
  await page.getByLabel(az.intake.signerName, { exact: true }).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
  await sign();
  await button(az.job.handOver).click();
  await status("TEHVIL_VERILDI");
  await expect(page.getByTestId("next-step")).toContainText(az.job.next.handedOver);
});

test("the car returns: found by its sticker, last client offered, lower odometer needs a reason", async () => {
  // Handed over, the car has left the workshop: its unpaid job does not block a new visit.
  await findBySticker(stickerToken);
  await expect(main().getByText(/Son səfərdəki müştəri/)).toBeVisible();
  await main()
    .getByRole("link", { name: new RegExp(az.intake.choose) })
    .click();
  await link(az.ui.continue).click();
  await expect(main().getByText(/Əvvəlki: 120 000 km/)).toBeVisible();

  // Lower than last time: the reason is required before "Davam et".
  for (const [slot, label] of Object.entries(az.intake.slot)) {
    await page.getByLabel(label, { exact: true }).setInputFiles(photo(slot));
  }
  await page.getByLabel(az.intake.kmLabel).fill("110000");
  await expect(main().getByRole("alert")).toContainText(az.intake.kmLowTitle);
  await expect(button(az.ui.continue)).toBeDisabled();
  await page.getByLabel(az.intake.reasonRequired).fill("Panel dəyişdirilib");
  await button(az.ui.continue).click();
  await complaintsAndSave();
  await expect(page).toHaveURL(/od=1/);
  await expect(main().getByRole("alert")).toHaveText(az.job.odometerFlagged);
});

test("the plate is a shortcut that still leads through the VIN", async () => {
  await page.goto("/qebul");
  await link(az.intake.mode.plate).click();
  await page.getByLabel(az.intake.searchPlate).fill("90 ab 123");
  await button(az.intake.find).click();
  await main()
    .getByRole("link", { name: /90-AB-123/ })
    .click();
  await expect(page.getByRole("heading", { name: az.intake.vinCheckHeading })).toBeVisible();
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
  await page.getByLabel(az.intake.clientSearch).press("Enter");
  await main()
    .getByRole("link", { name: /E2E Korporativ MMC/ })
    .click();
  await expect(main().getByText(az.intake.notOnContract)).toBeVisible();
  await expect(button(az.ui.continue)).toBeDisabled();
  await link(az.intake.separatePaid).click();
  await link(az.ui.continue).click();
  await takePhotos("54000");
  await complaintsAndSave();

  corporateJobId = page.url().match(/\/is\/([0-9a-f-]{36})/)![1]!;
  const [job] = await db
    .select({ check: jobOrders.contractCheck, decision: jobOrders.contractDecision })
    .from(jobOrders)
    .where(eq(jobOrders.id, corporateJobId));
  expect(job).toEqual({ check: "NOT_ON_CONTRACT", decision: "SEPARATE_PAID" });
  corporateSticker = await printSticker();
});

test("a car still in the workshop leads to its open job", async () => {
  await findBySticker(corporateSticker);
  await expect(main().getByText(az.intake.openJobExists)).toBeVisible();
  await link(az.intake.openJobLink).click();
  await expect(page).toHaveURL(new RegExp(`/is/${corporateJobId}$`));
  await expect(page.getByTestId("job-status")).toHaveText(az.status.QEBUL);
});
