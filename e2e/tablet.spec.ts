// Plan 04, P-e2e: the formen's tablet, landscape 1280x800 (design canvas "Planşet
// (formen)"). A new car from intake to TEHVIL_VERILDI; the same car back again, found by
// its sticker code; the plate shortcut; a corporate car not on its client's contract, then
// found by its sticker while still in the workshop. Warehouse and approval steps have no
// screens yet (milestone 5), so the test takes them through lib as those staff.
import { expect, test, type Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { contragents, jobOrders, partsRequests } from "../db/schema";
import { withActor, withReason } from "../lib/audit";
import { createContract } from "../lib/contracts";
import { moveJob } from "../lib/jobs";
import az from "../messages/az.json" with { type: "json" };
import { IDLE_SECONDS, MANAGER, WAREHOUSE } from "./fixtures";
import { db, idleSeconds, photo, signedInTablet, tablet, userId } from "./tablet-kit";

let page: Page;
let t: ReturnType<typeof tablet>;
let jobId: string;
let stickerToken: string;
let corporateJobId: string;
let corporateSticker: string;

// Serial, one signed-in tablet; dev compiles each screen on first visit, hence the timeout.
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

test("a new car from intake to handover", async () => {
  await t.link(az.board.receive).click();
  await t.newVehicle("Mercedes-Benz", "90-AB-123");

  // A new car has no last client: create one; an individual is not checked against contracts.
  await t.newPerson("Əli Məmmədov");
  await t.link(az.ui.continue).click();
  await t.takePhotos("120000");
  await t.complaintsAndSave();

  jobId = t.jobIdFromUrl();
  await expect(t.main().getByText(/İş sifarişi IS-\d{4}-\d{6} açıldı/)).toBeVisible();
  await t.status("QEBUL");
  stickerToken = await t.printSticker();
  await page.goto(`/is/${jobId}`);

  // 4.1 Inspection: a finding with a photo, its service and a part, in one form.
  await t.link(az.job.addFinding).click();
  await t.addFinding("Ön əyləc diskləri yeyilib", {
    service: "Ön əyləc disklərinin dəyişdirilməsi",
    part: "Əyləc diski",
  });
  // The photo is served back by /fayl to the signed-in tablet.
  const thumb = t.main().getByRole("img", { name: az.job.media });
  await expect(thumb).toBeVisible();
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(t.main().getByText("Əyləc diski", { exact: true })).toBeVisible();
  await t.button(az.job.sendToWarehouse).click();
  await expect(page).toHaveURL(/\/isler$/);
  await expect(
    t.main().getByRole("region", { name: az.board.lanes.office }).getByTestId("job-card"),
  ).toHaveCount(1);

  // Warehouse prices it and the client approves (milestone 5 and 6 screens).
  const warehouseId = await userId(WAREHOUSE.phone);
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
  await withActor(db, { userId: await userId(MANAGER.phone) }, (tx) =>
    moveJob(tx, jobId, "TESDIQLENDI", "e2e"),
  );

  // 5.x Work, the old part, the quality check.
  await page.goto(`/is/${jobId}`);
  await t.button(az.job.startWork).click();
  await t.status("TEMIRDE");
  await t.link(az.job.removedPart).click();
  await page.getByLabel(az.job.otherPartName).fill("Köhnə əyləc diski");
  await page.getByLabel(az.job.removedPhoto, { exact: true }).setInputFiles(photo("removed"));
  await t.button(az.ui.save).click();
  await expect(t.main().getByText("Köhnə əyləc diski")).toBeVisible();
  await t.link(az.job.qualityCheck).click();
  for (const label of Object.values(az.job.check)) await page.getByLabel(label).check();
  await page.getByLabel(az.job.dashboardPhoto, { exact: true }).setInputFiles(photo("dashboard"));
  await t.button(az.job.qcPass).click();
  await t.status("HAZIR");

  // 6.1 Handover with the collector's signature.
  await t.link(az.job.handOver).click();
  await page.getByLabel(az.intake.signerName, { exact: true }).fill("Əli Məmmədov");
  await page.getByLabel(az.intake.signerPhone, { exact: true }).fill("+994551234567");
  await t.sign();
  await t.button(az.job.handOver).click();
  await t.status("TEHVIL_VERILDI");
  await expect(page.getByTestId("next-step")).toContainText(az.job.next.handedOver);
});

test("the car returns: found by its sticker, last client offered, lower odometer needs a reason", async () => {
  // Handed over, the car has left the workshop: its unpaid job does not block a new visit.
  await t.findBySticker(stickerToken);
  await expect(t.main().getByText(/Son səfərdəki müştəri/)).toBeVisible();
  await t
    .main()
    .getByRole("link", { name: new RegExp(az.intake.choose) })
    .click();
  await t.link(az.ui.continue).click();
  await expect(t.main().getByText(/Əvvəlki: 120 000 km/)).toBeVisible();

  // Lower than last time: the reason is required before "Davam et".
  for (const [slot, label] of Object.entries(az.intake.slot)) {
    await page.getByLabel(label, { exact: true }).setInputFiles(photo(slot));
  }
  await page.getByLabel(az.intake.kmLabel).fill("110000");
  await expect(t.main().getByRole("alert")).toContainText(az.intake.kmLowTitle);
  await expect(t.button(az.ui.continue)).toBeDisabled();
  await page.getByLabel(az.intake.reasonRequired).fill("Panel dəyişdirilib");
  await t.button(az.ui.continue).click();
  await t.complaintsAndSave();
  await expect(page).toHaveURL(/od=1/);
  await expect(t.main().getByRole("alert")).toHaveText(az.job.odometerFlagged);
});

test("the plate is a shortcut that still leads through the VIN", async () => {
  await page.goto("/qebul");
  await t.link(az.intake.mode.plate).click();
  await page.getByLabel(az.intake.searchPlate).fill("90 ab 123");
  await t.button(az.intake.find).click();
  await t
    .main()
    .getByRole("link", { name: /90-AB-123/ })
    .click();
  await expect(page.getByRole("heading", { name: az.intake.vinCheckHeading })).toBeVisible();
});

test("a corporate car not on its client's contract needs the formen's decision", async () => {
  await withActor(db, { userId: await userId(MANAGER.phone) }, async (tx) => {
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

  await t.newVehicle("MAN", "10-KK-777");
  await page.getByLabel(az.intake.clientSearch).fill("Korporativ");
  await page.getByLabel(az.intake.clientSearch).press("Enter");
  await t
    .main()
    .getByRole("link", { name: /E2E Korporativ MMC/ })
    .click();
  await expect(t.main().getByText(az.intake.notOnContract)).toBeVisible();
  await expect(t.button(az.ui.continue)).toBeDisabled();
  await t.link(az.intake.separatePaid).click();
  await t.link(az.ui.continue).click();
  await t.takePhotos("54000");
  await t.complaintsAndSave();

  corporateJobId = t.jobIdFromUrl();
  const [job] = await db
    .select({ check: jobOrders.contractCheck, decision: jobOrders.contractDecision })
    .from(jobOrders)
    .where(eq(jobOrders.id, corporateJobId));
  expect(job).toEqual({ check: "NOT_ON_CONTRACT", decision: "SEPARATE_PAID" });
  corporateSticker = await t.printSticker();
});

test("a car still in the workshop leads to its open job", async () => {
  await t.findBySticker(corporateSticker);
  await expect(t.main().getByText(az.intake.openJobExists)).toBeVisible();
  await t.link(az.intake.openJobLink).click();
  await expect(page).toHaveURL(new RegExp(`/is/${corporateJobId}$`));
  await t.status("QEBUL");
});
