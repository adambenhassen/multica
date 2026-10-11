import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const apiRef = vi.hoisted(() => ({ current: {} as Record<string, () => Promise<unknown>> }));

// Any endpoint a test does not script stays in flight: the page must render
// its other sections without it.
vi.mock("@multica/core/api", () => ({
  api: new Proxy(
    {},
    { get: (_, name: string) => apiRef.current[name] ?? (() => new Promise(() => {})) },
  ),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => (id === "agent-1" ? "Builder" : "Unknown"),
  }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("../../common/use-viewing-timezone", () => ({ useViewingTimezone: () => "UTC" }));

import { OverviewPage } from "./overview-page";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/dashboard",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path: string) => path,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={adapter}>
        <OverviewPage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiRef.current = {};
});

describe("OverviewPage", () => {
  it("shows empty states when the workspace has no runs, activity or issues", async () => {
    apiRef.current = {
      getAgentTaskSnapshot: () => Promise.resolve([]),
      listWorkspaceActivity: () => Promise.resolve({ entries: [] }),
      listIssues: () => Promise.resolve({ issues: [], total: 0 }),
    };
    renderPage();

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(await screen.findByText("No recent agent runs")).toBeTruthy();
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(await screen.findByText("No issues yet")).toBeTruthy();
  });

  it("links activity rows and metric cards to their pages", async () => {
    apiRef.current = {
      listWorkspaceActivity: () =>
        Promise.resolve({
          entries: [
            {
              type: "activity",
              id: "act-1",
              actor_type: "agent",
              actor_id: "agent-1",
              created_at: new Date().toISOString(),
              action: "created",
              issue: { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "todo" },
            },
          ],
        }),
      listIssueTableFacets: () =>
        Promise.resolve({
          query_fingerprint: "",
          total: 0,
          facets: [
            {
              kind: "status",
              values: [
                { key: "todo", count: 4 },
                { key: "in_progress", count: 3 },
                { key: "in_review", count: 2 },
                { key: "blocked", count: 1 },
              ],
            },
          ],
        }),
    };
    renderPage();

    const row = (await screen.findByText("Ship the dashboard")).closest("a");
    expect(row?.getAttribute("href")).toBe("/acme/issues/issue-1");
    expect(within(row!).getByText("Builder")).toBeTruthy();
    expect(within(row!).getByText("MUL-1")).toBeTruthy();

    const issuesCard = screen.getByText("Issues in progress").closest("a")!;
    expect(issuesCard.getAttribute("href")).toBe("/acme/issues");
    expect(await within(issuesCard).findByText("5")).toBeTruthy();
    expect(within(issuesCard).getByText("4 to do · 1 blocked")).toBeTruthy();

    expect(screen.getByText("Agents online").closest("a")?.getAttribute("href")).toBe("/acme/agents");
    expect(screen.getByText("Spend · 30d").closest("a")?.getAttribute("href")).toBe("/acme/usage");
    expect(screen.getByText("Unread in inbox").closest("a")?.getAttribute("href")).toBe("/acme/inbox");
  });
  it("reports a failed section instead of showing it as empty, and retries it", async () => {
    let activityCalls = 0;
    apiRef.current = {
      listWorkspaceActivity: () => {
        activityCalls += 1;
        return activityCalls === 1
          ? Promise.reject(new Error("404"))
          : Promise.resolve({ entries: [] });
      },
      getDashboardUsageDaily: () => Promise.reject(new Error("500")),
    };
    renderPage();

    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;
    expect(await within(activity).findByText("Couldn't load")).toBeTruthy();
    expect(within(activity).queryByText("No activity yet")).toBeNull();
    const spendCard = screen.getByText("Spend · 30d").closest("a")!;
    expect(await within(spendCard).findByText("—")).toBeTruthy();
    expect(within(spendCard).queryByText(/\$0/)).toBeNull();

    fireEvent.click(within(activity).getByRole("button", { name: "Try again" }));
    expect(await within(activity).findByText("No activity yet")).toBeTruthy();
  });
});
