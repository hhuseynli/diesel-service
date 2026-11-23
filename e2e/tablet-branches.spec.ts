// The tablet's other paths (design canvas "Planşet (formen)", spec 01 §3.2-3.7 and §6):
// cancelling at intake and the refusal after it, a car that changed hands, the VÖEN check,
// corrections with a reason, a finding during work, a failed quality check, a new
// mechanic, a plate changed at the VIN check, a reprinted sticker, and the QR link.
import { expect, test, type Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { jobOrders } from "../db/schema";
import { withActor } from "../lib/audit";
import { moveJob } from "../lib/jobs";
import az from "../messages/az.json" with { type: "json" };
import { IDLE_SECONDS, MANAGER, MECHANIC_2, WAREHOUSE } from "./fixtures";
import { db, idleSeconds, photo, signedInTablet, tablet, userId } from "./tablet-kit";

let page: Page;
let t: ReturnType<typeof tablet>;
let carToken: string;
let secondJob: string;

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({ browser }) => {
  await idleSeconds(600);
  page = await signedInTablet(browser);
  t = tablet(page);
});

test.afterAll(async () => {
  await page?.context().close();
  await idleSeconds(IDLE_SECONDS);
});

test("cancelling at intake needs a reason, and the job keeps it", async () => {
  await t.newVehicle("Volvo", "77-BR-001");
  await t.newPerson("Kamran Əliyev");
  await t.link(az.ui.continue).click();
  await t.takePhotos("80000");
  await t.complaintsAndSave();
  const jobId = t.jobIdFromUrl();
  carToken = await t.printSticker();

  await page.goto(`/is/${jobId}`);
  await t.link(az.job.cancelJob).click();
  const dialog = page.getByRole("dialog", { name: az.job.cancelTitle });
  await expect(dialog).toBeVisible();
  await dialog.getByText(az.job.reasons.wrongCar, { exact: true }).click();
  await dialog.getByLabel(az.job.cancelDetails).fill("Başqa maşın idi");
  await dialog.getByRole("button", { name: az.job.cancelConfirm }).click();
  await t.status("LEGV");
  await expect(page.getByTestId("next-step")).toContainText(
    `${az.job.reasons.wrongCar}: Başqa maşın idi`,
  );
});

test("a new owner: the VÖEN is checked and the formen answers 'Sahibi dəyişib?'", async () => {
  // Cancelled, the car has no open job; the last visit's client is offered first.
  await t.findBySticker(carToken);
  await expect(t.main().getByText("Kamran Əliyev")).toBeVisible();
  await t.link(az.intake.newClient).click();
  await page.getByText(az.intake.legal, { exact: true }).click();
  await page.getByLabel(az.intake.name, { exact: true }).fill("E2E Yeni Sahib MMC");
  await page.getByLabel(az.intake.voen, { exact: true }).fill("123");
  await t.button(az.intake.createClient).click();
  await expect(t.main().getByRole("alert")).toHaveText(az.errors.invalidInput);

  // The form stays open; a 10-digit VÖEN is accepted.
  await page.getByText(az.intake.legal, { exact: true }).click();
  await page.getByLabel(az.intake.name, { exact: true }).fill("E2E Yeni Sahib MMC");
  await page.getByLabel(az.intake.voen, { exact: true }).fill("1700412345");
  await t.button(az.intake.createClient).click();
  const owner = page.getByRole("dialog", { name: az.intake.ownerChanged });
  await expect(owner).toBeVisible();
  await owner.getByRole("link", { name: az.intake.ownerYes }).click();
  await expect(t.main().getByText(az.intake.companyNoContract)).toBeVisible();
  await t.link(az.ui.continue).click();
  await t.takePhotos("81000");
  await t.complaintsAndSave();

  secondJob = t.jobIdFromUrl();
  const [job] = await db
    .select({ ownerChanged: jobOrders.ownerChanged })
    .from(jobOrders)
    .where(eq(jobOrders.id, secondJob));
  expect(job!.ownerChanged).toBe(true);
});

test("after inspection: no cancel for the formen, a correction with a reason, a finding during work, a failed check, a new mechanic", async () => {
  await page.goto(`/is/${secondJob}`);
  await t.link(az.job.addFinding).click();
  await t.addFinding("Sol fara çatlayıb");
  await t.button(az.job.sendToWarehouse).click();
  await expect(page).toHaveURL(/\/isler$/);

  // Past QEBUL only management cancels (spec 01, 6).
  await page.goto(`/is/${secondJob}`);
  await t.link(az.job.cancelJob).click();
  const denied = page.getByRole("alertdialog", { name: az.job.deniedTitle });
  await expect(denied).toBeVisible();
  await denied.getByRole("link", { name: az.job.close }).click();
  await t.status("BAXIS");

  // A correction is a new finding with its reason; the original stays.
  await t.link(az.job.findingFix).click();
  await page.getByLabel(az.job.what).fill("Sağ fara çatlayıb");
  await page.getByLabel(az.job.fixReason).fill("Tərəf səhv yazılmışdı");
  await page.getByLabel(az.job.mediaTile, { exact: true }).setInputFiles(photo("fix"));
  await t.button(az.ui.save).click();
  await expect(t.main().getByText("Sol fara çatlayıb")).toBeVisible();
  await expect(t.main().getByText("Sağ fara çatlayıb")).toBeVisible();
  await expect(t.main().getByText(/Düzəliş · səbəb: Tərəf səhv yazılmışdı/)).toBeVisible();

  // Warehouse and client (milestones 5 and 6).
  await withActor(db, { userId: await userId(WAREHOUSE.phone) }, async (tx) => {
    await moveJob(tx, secondJob, "QIYMETLENDIRME", "e2e");
    await moveJob(tx, secondJob, "TESDIQ_GOZLEYIR", "e2e");
  });
  await withActor(db, { userId: await userId(MANAGER.phone) }, (tx) =>
    moveJob(tx, secondJob, "TESDIQLENDI", "e2e"),
  );
  await page.goto(`/is/${secondJob}`);
  await t.button(az.job.startWork).click();
  await t.status("TEMIRDE");

  // Found during work: marked "Təmir zamanı", an Əlavə akt request.
  await t.link(az.job.extraFinding).click();
  await expect(page.getByText(az.job.duringTitle)).toBeVisible();
  await t.addFinding("Arxa amortizator sızır");
  await expect(t.main().getByText(az.job.duringWork)).toBeVisible();

  // A failed check keeps the car in work.
  await t.link(az.job.qualityCheck).click();
  await page.getByLabel(az.job.dashboardPhoto, { exact: true }).setInputFiles(photo("dash"));
  await t.button(az.job.qcFail).click();
  await expect(t.main().getByRole("alert")).toHaveText(az.job.checkFailed);
  await t.status("TEMIRDE");

  // The job's mechanic changes while the work is open.
  await t.link(az.job.assignMechanic).click();
  await page.getByText(MECHANIC_2.name, { exact: true }).click();
  await t.button(az.job.assign).click();
  await expect(page.locator(".kv")).toContainText(MECHANIC_2.name);
});

test("at the VIN check: a changed plate is kept as history, and a reprinted sticker warns", async () => {
  await t.findBySticker(carToken, false);
  await t.link(az.intake.plateChanged).click();
  await page.getByLabel(az.intake.newPlate).fill("77-BR-002");
  await t.button(az.intake.saveAndMatch).click();
  // The car is still in the workshop, so the VIN check leads to its job.
  await expect(t.main().getByText(az.intake.openJobExists)).toBeVisible();
  const { rows } = await db.execute<{ plate: string; status: string }>(sql`
    SELECT vp.plate_display AS plate, vp.status FROM vehicle_plates vp
      JOIN job_orders j ON j.vehicle_id = vp.vehicle_id
     WHERE j.id = ${secondJob} ORDER BY vp.created_at`);
  expect(rows).toEqual([
    { plate: "77-BR-001", status: "ENDED" },
    { plate: "77-BR-002", status: "ACTIVE" },
  ]);

  await t.findBySticker(carToken, false);
  await t.link(az.intake.reprint).click();
  await page.getByLabel(az.sticker.reason).fill("Stiker cırılıb");
  await t.button(az.sticker.reprintSubmit).click();
  await expect(page.getByTestId("sticker").locator("svg")).toBeVisible();
  const fresh = new URL(page.url()).pathname.split("/").pop()!;
  expect(fresh).not.toBe(carToken);

  // The old label still finds the car, with a warning.
  await t.findBySticker(carToken, false);
  await expect(t.main().getByRole("alert")).toContainText(az.intake.replacedSticker);

  // A phone camera opens /q/<token>: signed in, it leads to the car's VIN check.
  await page.goto(`/q/${fresh}`);
  await expect(page.getByRole("heading", { name: az.intake.vinCheckHeading })).toBeVisible();
});

test("photos are served only to signed-in staff", async ({ request }) => {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT attachment_id AS id FROM intake_photos LIMIT 1`,
  );
  // `request` carries no session cookie.
  const signedOut = await request.get(`/fayl/${rows[0]!.id}`);
  expect(signedOut.status()).toBe(401);
  const signedIn = await page.request.get(`/fayl/${rows[0]!.id}`);
  expect(signedIn.status()).toBe(200);
  expect(signedIn.headers()["content-type"]).toBe("image/jpeg");
});
