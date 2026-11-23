// Plan 03, P8: office sign-in with password and TOTP, the tablet PIN switch, idle lock,
// and sign-out, against the e2e database (e2e/prepare-db.ts).
import { expect, test, type Page } from "@playwright/test";
import { base32Decode, totp } from "../lib/auth/crypto";
import az from "../messages/az.json" with { type: "json" };
import { CASHIER, FORMEN, IDLE_SECONDS, MANAGER } from "./fixtures";

const signedInAs = (name: string) => az.home.signedInAs.replace("{name}", name);

async function officeSignIn(page: Page, phone: string, password: string, totpCode?: string) {
  await page.goto("/giris");
  await page.getByLabel(az.auth.phone).fill(phone);
  await page.getByLabel(az.auth.password).fill(password);
  if (totpCode) await page.getByLabel(az.auth.totp).fill(totpCode);
  await page.getByRole("button", { name: az.auth.signIn }).click();
}

test("a wrong password is refused", async ({ page }) => {
  await officeSignIn(page, CASHIER.phone, "yanlis-sifre-123");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(az.auth.errors.INVALID);
});

test("the cashier signs in with a password and out again", async ({ page }) => {
  await officeSignIn(page, CASHIER.phone, CASHIER.password);
  await expect(page.getByText(signedInAs(CASHIER.name))).toBeVisible();
  await expect(page.getByText(az.home.roles.replace("{roles}", az.roles.CASHIER))).toBeVisible();
  await page.getByRole("button", { name: az.home.signOut }).click();
  await expect(page).toHaveURL(/\/giris$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/giris$/);
});

test("management needs a TOTP code; then registers the tablet; staff switch in by PIN; idle locks", async ({
  page,
}) => {
  await officeSignIn(page, MANAGER.phone, MANAGER.password);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(az.auth.errors.TOTP_REQUIRED);

  const code = totp(base32Decode(MANAGER.totpSecret), Math.floor(Date.now() / 1000));
  await officeSignIn(page, MANAGER.phone, MANAGER.password, code);
  await expect(page.getByText(signedInAs(MANAGER.name))).toBeVisible();

  await page.getByLabel(az.home.tabletName).fill("Sex planşeti");
  await page.getByRole("button", { name: az.home.registerTablet }).click();
  await expect(page.getByText(az.home.tabletRegistered)).toBeVisible();

  // On the tablet, signing out means switching user.
  await page.getByRole("button", { name: az.home.switchUser }).click();
  await expect(page).toHaveURL(/\/pin$/);
  await page.getByLabel(az.auth.who).selectOption({ label: FORMEN.name });
  await page.getByLabel(az.auth.pin).fill("0000");
  await page.getByRole("button", { name: az.auth.pin }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(az.auth.errors.INVALID);

  await page.getByLabel(az.auth.who).selectOption({ label: FORMEN.name });
  await page.getByLabel(az.auth.pin).fill(FORMEN.pin);
  await page.getByRole("button", { name: az.auth.pin }).click();
  await expect(page.getByText(signedInAs(FORMEN.name))).toBeVisible();

  // Idle longer than the tablet timeout: the next request goes back to the PIN screen.
  await page.waitForTimeout((IDLE_SECONDS + 1) * 1000);
  await page.reload();
  await expect(page).toHaveURL(/\/pin$/);
});
