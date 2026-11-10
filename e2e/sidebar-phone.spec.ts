import { test, expect, type Locator, type Page } from "@playwright/test";
import { createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

// The navigation drawer at phone size with touch input. 360×656 is what a
// Galaxy S25 leaves a page once the browser's own bars are on screen.

const VIEWPORT = { width: 360, height: 656 };

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** Two Claude accounts and Codex: seven quota rows, as on a busy workspace. */
async function mockProviderQuota(page: Page) {
  const claude = (label: string, session: number, weekly: number, fable: number) => ({
    id: `claude-${label}`,
    provider: "claude",
    label,
    error: null,
    updated_at: null,
    windows: [
      { kind: "session", used_percent: session, resets_at: soon(137) },
      { kind: "weekly", used_percent: weekly, resets_at: soon(60 * 24) },
      { kind: "fable", used_percent: fable, resets_at: soon(60 * 24) },
    ],
  });
  await page.route("**/api/provider-quota", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [
          claude("first@example.com", 86, 78, 10),
          claude("second@example.com", 18, 7, 0),
          {
            id: "codex-main",
            provider: "codex",
            label: "main",
            error: null,
            updated_at: null,
            windows: [{ kind: "weekly", used_percent: 21, resets_at: soon(60 * 24 * 4) }],
          },
        ],
      }),
    }),
  );
}

async function isOnScreen(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  return box !== null && box.y >= 0 && box.y + box.height <= VIEWPORT.height;
}

test.describe("Navigation drawer on a phone", () => {
  test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });

  let api: TestApiClient;

  test.beforeEach(async () => {
    api = await createTestApi();
  });

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("shows the main destinations at once and scrolls as one column", async ({ page }) => {
    const [workspace] = await api.getWorkspaces();
    await mockProviderQuota(page);
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${workspace!.slug}/issues`, { waitUntil: "domcontentloaded" });
    await waitForPageText(page, "Issues");

    await page.getByRole("button", { name: "Toggle left sidebar" }).tap();
    const drawer = page.getByRole("dialog");
    const link = (name: string) => drawer.getByRole("link", { name, exact: true });
    await expect(link("Inbox")).toBeVisible();

    // The quota panel is one line until it is asked for.
    const quota = drawer.getByRole("button", { name: /Provider quota/ });
    await expect(quota).toHaveAttribute("aria-expanded", "false");
    await expect(quota).toContainText("86%");
    await expect(drawer.getByRole("progressbar")).toHaveCount(0);

    // Every work and team destination is on screen without scrolling.
    for (const name of ["Issues", "Projects", "Agents", "Runtimes"]) {
      expect(await isOnScreen(link(name)), `${name} is on screen`).toBe(true);
    }

    // Nothing a touch screen cannot use.
    await expect(drawer.locator("kbd:visible")).toHaveCount(0);
    await expect(drawer.getByText("Join our Discord")).toHaveCount(0);

    // One scroller: the nav list does not scroll inside the drawer, and the
    // drawer's end is reachable.
    const navScrolls = await drawer
      .locator('[data-slot="sidebar-content"]')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(navScrolls).toBe(false);
    await quota.tap();
    await expect(quota).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.getByRole("progressbar")).toHaveCount(7);
    await link("Settings").scrollIntoViewIfNeeded();
    expect(await isOnScreen(link("Settings"))).toBe(true);
  });
});
