import { test, expect } from "@playwright/test";
import { createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

// The Activity page at phone size with touch input (Galaxy S25: 360×780).
test.describe("Activity page on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  let api: TestApiClient;

  test.beforeEach(async () => {
    api = await createTestApi();
  });

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("names the page, fills the screen and says what each row did", async ({ page }) => {
    const title = `E2E activity phone ${Date.now()} with a title that needs a second line`;
    const issue = await api.createIssue(title);
    await api.updateIssue(issue.id, { status: "in_progress" });
    // `loginAsDefault` waits for desktop chrome a phone keeps in the nav sheet.
    const [workspace] = await api.getWorkspaces();
    const slug = workspace!.slug;
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${slug}/dashboard`, { waitUntil: "domcontentloaded" });
    await waitForPageText(page, title);

    // The page title is not squeezed out by the header controls.
    const heading = page.getByRole("heading", { level: 1, name: "Activity" });
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.getByRole("button", { name: /runs? working/ })).toBeHidden();

    // The newest row of the issue is its move.
    const row = page.getByRole("link").filter({ hasText: title }).first();

    // The whole title shows, on two lines.
    const titleBox = await row.getByText(title, { exact: true }).evaluate((el) => ({
      clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      height: el.getBoundingClientRect().height,
    }));
    expect(titleBox.clipped).toBe(false);
    expect(titleBox.height).toBeGreaterThan(30);

    // The row names the status the issue moved into, in view rather than in a tooltip.
    const labelWidths = await row
      .getByText("In Progress", { exact: true })
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.max(...labelWidths)).toBeGreaterThan(30);

    // The list is the only scroller and reaches the bottom of the screen.
    const list = row.locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
    const listBox = (await list.boundingBox())!;
    expect(listBox.y + listBox.height).toBeGreaterThanOrEqual(779);
    expect(listBox.width).toBe(360);

    // Touch has no hover: the row's filter button is gone, and a tap anywhere
    // on the row opens the issue.
    const rowBox = (await row.boundingBox())!;
    await expect(row.locator("xpath=..").getByRole("button", { name: "Show only this issue" })).toBeHidden();
    await page.touchscreen.tap(rowBox.x + rowBox.width - 24, rowBox.y + rowBox.height / 2);
    // The detail page swaps the id in the URL for the issue's identifier.
    await expect(page).toHaveURL(new RegExp(`/${slug}/issues/(${issue.id}|${issue.identifier})$`), { timeout: 30000 });
  });
});
