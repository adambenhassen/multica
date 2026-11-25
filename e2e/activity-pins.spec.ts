import { test, expect } from "@playwright/test";
import { createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("Activity pins", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  let api: TestApiClient;

  test.beforeEach(async () => {
    api = await createTestApi();
  });

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("pins an issue above the day groups, keeps it across reloads and unpins it", async ({ page }) => {
    const stamp = Date.now();
    const pinnedTitle = `E2E pinned ${stamp}`;
    const otherTitle = `E2E newer ${stamp}`;
    const pinned = await api.createIssue(pinnedTitle, { priority: "urgent" });
    await api.updateIssue(pinned.id, { status: "in_progress" });
    const other = await api.createIssue(otherTitle);
    await api.updateIssue(other.id, { status: "in_progress" });
    const [workspace] = await api.getWorkspaces();
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${workspace!.slug}/dashboard`, { waitUntil: "domcontentloaded" });
    await waitForPageText(page, pinnedTitle);

    const feed = page.locator("section", { has: page.getByRole("heading", { name: "Recent activity" }) });
    const rowOf = (title: string) => feed.getByRole("link").filter({ hasText: title }).first();
    // Each row leads with its issue's priority.
    await expect(rowOf(pinnedTitle).getByTitle("Urgent")).toBeVisible();

    await rowOf(pinnedTitle).hover();
    await rowOf(pinnedTitle).locator("xpath=..").getByRole("button", { name: "Pin to top" }).click();
    const heading = feed.getByText("Pinned", { exact: true });
    await expect(heading).toBeVisible();
    // The pinned issue is lifted above the newer one, and shows once.
    const titles = feed.getByRole("link").filter({ hasText: String(stamp) });
    await expect(titles).toHaveCount(2);
    await expect(titles.first()).toContainText(pinnedTitle);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(heading).toBeVisible();
    await expect(titles.first()).toContainText(pinnedTitle);

    await rowOf(pinnedTitle).hover();
    await rowOf(pinnedTitle).locator("xpath=..").getByRole("button", { name: "Unpin" }).click();
    await expect(heading).toBeHidden();
    await expect(titles.first()).toContainText(otherTitle);
  });
});
