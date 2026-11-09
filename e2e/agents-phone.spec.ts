import { test, expect, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { waitForPageText } from "./helpers";

// The Agents list at phone size with touch input (Galaxy S25: 360×780).
//
// The agents are mocked at the list endpoint, bound to a real seeded runtime,
// so the spec needs no daemon to create them.

const E2E_WORKER = process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? "0";
const E2E_RUN_ID = process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid.toString(36)}`;

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_NAME = "Frontend Reviewer for the web";
const RUNTIME_NAME = "Phone Mac";

function mockAgent(id: string, name: string, ownerId: string, workspaceId: string, runtimeId: string) {
  return {
    id,
    workspace_id: workspaceId,
    runtime_id: runtimeId,
    name,
    description: "Reviews UI pull requests.",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "workspace",
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: ownerId,
    skills: [],
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
    archived_at: null,
    archived_by: null,
  };
}

async function mockAgentList(page: Page, ownerId: string, workspaceId: string, runtimeId: string) {
  await page.route("**/api/agents**", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).pathname.endsWith("/api/agents")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          mockAgent(AGENT_ID, AGENT_NAME, ownerId, workspaceId, runtimeId),
          mockAgent("44444444-4444-4444-8444-444444444444", "Release Captain", ownerId, workspaceId, runtimeId),
        ]),
      });
    }
    return route.fallback();
  });
  // The first agent last ran five minutes ago; the second has never run.
  await page.route("**/api/agent-run-counts**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          agent_id: AGENT_ID,
          run_count: 3,
          last_hour_count: 1,
          last_run_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      ]),
    }),
  );
}

test.describe("Agents list on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  let api: TestApiClient;

  test.afterEach(async () => {
    await api?.deleteWorkspace();
  });

  test("shows each agent's whole name, status, runtime and last activity in a tappable row", async ({ page }) => {
    api = new TestApiClient();
    const login = await api.login(`e2e-agents-phone-${E2E_WORKER}-${E2E_RUN_ID}@multica.ai`, "E2E Agents Phone");
    const workspace = await api.ensureWorkspace(
      `E2E Agents Phone ${E2E_WORKER}`,
      `e2e-agents-phone-${E2E_WORKER}-${E2E_RUN_ID}`,
    );
    await api.markUserOnboarded();
    const runtimeId = await api.seedRuntime(RUNTIME_NAME);
    await mockAgentList(page, login.user.id, workspace.id, runtimeId);
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${workspace.slug}/agents`, { waitUntil: "domcontentloaded" });
    await waitForPageText(page, AGENT_NAME);

    const row = page.getByRole("row").filter({ hasText: AGENT_NAME });

    // The name is not cut short by a status column.
    const name = row.getByText(AGENT_NAME, { exact: true });
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // The second line says where the agent runs and when it last worked.
    await expect(row.getByText(RUNTIME_NAME)).toBeVisible();
    await expect(row.getByText("5m ago")).toBeVisible();
    // An agent that has not run says nothing about when.
    const idle = page.getByRole("row").filter({ hasText: "Release Captain" });
    await expect(idle.getByText(RUNTIME_NAME)).toBeVisible();
    await expect(idle.getByText(/ago|No activity/)).toHaveCount(0);
    // No text in the row is clipped.
    const clipped = await row.evaluate((el) =>
      [...el.querySelectorAll("span")]
        .filter((s) => s.children.length === 0 && s.scrollWidth > s.clientWidth + 1)
        .map((s) => s.textContent),
    );
    expect(clipped).toEqual([]);

    // Fingertip-sized: the row and its menu.
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.height).toBeGreaterThanOrEqual(56);
    const menuBox = (await row.getByRole("button", { name: "Row actions" }).boundingBox())!;
    expect(menuBox.width).toBeGreaterThanOrEqual(44);
    expect(menuBox.height).toBeGreaterThanOrEqual(44);

    // The column header gives its height to the rows; sorting stays in the toolbar.
    await expect(page.getByRole("columnheader")).toHaveCount(0);

    // A tap on the row opens the agent.
    await page.touchscreen.tap(rowBox.x + 120, rowBox.y + rowBox.height / 2);
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/agents/${AGENT_ID}`), { timeout: 30000 });
  });
});
