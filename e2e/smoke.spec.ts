import { expect, test } from "@playwright/test";
import az from "../messages/az.json" with { type: "json" };

test("home page renders the heading from messages/az.json", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(az.home.title);
  await expect(page.locator("html")).toHaveAttribute("lang", "az");
});
