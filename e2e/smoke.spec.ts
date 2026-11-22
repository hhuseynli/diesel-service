import { expect, test } from "@playwright/test";
import az from "../messages/az.json" with { type: "json" };

test("signed out, the home page leads to sign-in, rendered from messages/az.json", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/giris$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(az.auth.signInTitle);
  await expect(page.locator("html")).toHaveAttribute("lang", "az");
});
