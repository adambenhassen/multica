import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ enableHoverCard }: { enableHoverCard?: boolean }) => (
    <span data-testid="avatar" data-hover-card={enableHoverCard ? "on" : "off"} />
  ),
}));
vi.mock("../../common/use-viewing-timezone", () => ({ useViewingTimezone: () => "UTC" }));

import { useOverviewLayoutStore } from "@multica/core/overview";
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
  it("shows empty states when the workspace has no runs, activity or status changes", async () => {
    apiRef.current = {
      getAgentTaskSnapshot: () => Promise.resolve([]),
      listWorkspaceActivity: () => Promise.resolve({ entries: [] }),
    };
    renderPage();

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(await screen.findByText("No recent agent runs")).toBeTruthy();
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(await screen.findByText("No status changes yet")).toBeTruthy();
  });

  it("links activity rows and metric cards to their pages", async () => {
    apiRef.current = {
      listWorkspaceActivity: ((params: { kind?: string }) =>
        Promise.resolve({
          entries: params.kind === "status" ? [] : [
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
        })) as () => Promise<unknown>,
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

  it("filters status changes by the status they went into", async () => {
    const status = (key: string, category: string, position: number) => ({
      id: key, workspace_id: "ws-1", key, name: key, description: "", category, color: "#888888",
      icon: null, is_system: false, position, archived_at: null, created_at: "", updated_at: "",
    });
    const calls: { kind?: string; to?: string[] }[] = [];
    apiRef.current = {
      listIssueStatuses: () =>
        Promise.resolve({
          statuses: [
            status("todo", "unstarted", 0),
            status("in_progress", "started", 1),
            status("qa", "started", 2),
            status("blocked", "started", 3),
            status("done", "done", 4),
          ],
          categories: ["unstarted", "started", "done", "closed"],
          total: 5,
        }),
      listWorkspaceActivity: ((params: { kind?: string; to?: string[] }) => {
        calls.push(params);
        return Promise.resolve({ entries: [] });
      }) as () => Promise<unknown>,
    };
    renderPage();

    const section = screen.getByRole("heading", { name: "Status changes" }).closest("section")!;
    await within(section).findByText("No status changes yet");
    const statusCalls = () => calls.filter((c) => c.kind === "status");
    expect(statusCalls().at(-1)).toEqual({ limit: 50, kind: "status", to: [] });

    fireEvent.click(within(section).getByRole("button", { name: "Blocked" }));
    await within(section).findByText("No changes into this status");
    expect(statusCalls().at(-1)?.to).toEqual(["blocked"]);

    fireEvent.click(within(section).getByRole("button", { name: "In progress" }));
    await waitFor(() => expect(statusCalls().at(-1)?.to).toEqual(["in_progress", "qa"]));

    fireEvent.click(within(section).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(statusCalls().at(-1)?.to).toEqual(["done"]));
  });

  it("reads activity as plain sentences under each issue and filters comments", async () => {
    const calls: unknown[] = [];
    const now = new Date().toISOString();
    const issue = { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "done" };
    const statusEntry = {
      type: "activity",
      id: "a-1",
      actor_type: "agent",
      actor_id: "agent-1",
      created_at: now,
      action: "status_changed",
      details: { from: "in_review", to: "done" },
      issue,
    };
    apiRef.current = {
      listWorkspaceActivity: ((params: { kind?: string }) => {
        calls.push(params);
        if (params.kind === "status") return Promise.resolve({ entries: [statusEntry] });
        return Promise.resolve({
          entries: [
            {
              type: "comment",
              id: "c-1",
              actor_type: "agent",
              actor_id: "agent-1",
              created_at: now,
              content: "Looks **good**, merging [@Ada](mention://member/u1)",
              issue,
            },
            statusEntry,
          ],
        });
      }) as () => Promise<unknown>,
    };
    renderPage();

    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;
    const comment = (await within(activity).findByText(/commented: “Looks good, merging @Ada”/)).closest("a")!;
    expect(comment.getAttribute("href")).toBe("/acme/issues/issue-1#comment-c-1");
    expect(within(comment).getByText("MUL-1")).toBeTruthy();
    // A status change shows the move itself rather than a sentence.
    expect(within(activity).getByLabelText("→")).toBeTruthy();
    expect(within(activity).queryByText("marked it Done")).toBeNull();
    expect(within(activity).getByText("Today")).toBeTruthy();
    expect(within(activity).queryByRole("button", { name: "Status changes" })).toBeNull();

    // The Status changes section shows each move itself instead of a sentence.
    const statusChanges = screen.getByRole("heading", { name: "Status changes" }).closest("section")!;
    expect(await within(statusChanges).findByLabelText("→")).toBeTruthy();
    expect(within(statusChanges).queryByText("marked it Done")).toBeNull();

    fireEvent.click(within(activity).getByRole("button", { name: "Comments" }));
    await screen.findAllByText(/commented/);
    expect(calls.at(-1)).toEqual({ limit: 50, kind: "comments", to: [] });

    fireEvent.click(within(activity).getByRole("button", { name: "Failures" }));
    await screen.findAllByText(/commented/);
    expect(calls.at(-1)).toEqual({ limit: 50, kind: "failures", to: [] });
  });

  it("shows each event on one line and names what it hides on hover", async () => {
    const now = new Date().toISOString();
    apiRef.current = {
      listWorkspaceActivity: () =>
        Promise.resolve({
          entries: [
            {
              type: "comment",
              id: "c-1",
              actor_type: "agent",
              actor_id: "agent-1",
              created_at: now,
              content: "Waiting for green CI",
              issue: { id: "issue-2", identifier: "MUL-2", title: "Fix the reconnect", status: "in_review" },
            },
            {
              type: "activity",
              id: "a-1",
              actor_type: "agent",
              actor_id: "agent-1",
              created_at: now,
              action: "status_changed",
              details: { from: "in_review", to: "done" },
              issue: { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "done" },
            },
          ],
        }),
    };
    renderPage();
    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;
    await within(activity).findByText("Ship the dashboard");
    const row = within(activity).getByText("Ship the dashboard").closest("a")!;
    // The move as icons, then the avatar; names stay for screen readers.
    expect(within(row).getByLabelText("→")).toBeTruthy();
    expect(within(row).getByText("Done").className).toContain("sr-only");
    expect(within(row).getByText("Builder").className).toContain("sr-only");
    // Hover names the rest: the full title, who acted, the action and each status.
    expect(within(row).getByText("Ship the dashboard").getAttribute("title")).toBe("Ship the dashboard");
    expect(within(row).getByTestId("avatar").dataset.hoverCard).toBe("on");
    expect(row.querySelector('[title="marked it Done"]')).not.toBeNull();
    expect(row.querySelector('[title="In Review"]')).not.toBeNull();
    expect(row.querySelector('[title="Done"]')).not.toBeNull();
    // A comment's text is its icon's tooltip, not a visible line.
    const comment = within(activity).getByText("Fix the reconnect").closest("a")!;
    expect(comment.querySelector('[title="commented: “Waiting for green CI”"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Compact rows" })).toBeNull();
  });

  it("labels rows with their project on request and filters both feeds to a project", async () => {
    const now = new Date().toISOString();
    const calls: { kind?: string; project?: string }[] = [];
    apiRef.current = {
      listProjects: () =>
        Promise.resolve({
          projects: [{ id: "project-1", title: "Teagram server", icon: null }],
          total: 1,
        }),
      listWorkspaceActivity: ((params: { kind?: string; project?: string }) => {
        calls.push(params);
        return Promise.resolve({
          entries: [
            {
              type: "activity",
              id: params.kind === "status" ? "s-1" : "a-1",
              actor_type: "agent",
              actor_id: "agent-1",
              created_at: now,
              action: "status_changed",
              details: { from: "todo", to: "done" },
              issue: { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "done", project_id: "project-1" },
            },
          ],
        });
      }) as () => Promise<unknown>,
    };
    renderPage();
    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;
    await within(activity).findByText("Ship the dashboard");
    expect(within(activity).queryByText("Teagram server")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Project labels" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(useOverviewLayoutStore.getState().showProjects).toBe(true);
    expect(await within(activity).findByText("Teagram server")).toBeTruthy();
    useOverviewLayoutStore.setState({ showProjects: false });

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Teagram server" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.project === "project-1").map((c) => c.kind).sort()).toEqual(["all", "status"]),
    );
  });

  it("tints an issue's rows in both feeds on hover and filters both to it", async () => {
    const now = new Date().toISOString();
    const ship = { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "done" };
    const fix = { id: "issue-2", identifier: "MUL-2", title: "Fix the reconnect", status: "todo" };
    const move = (id: string, issue: typeof ship) => ({
      type: "activity",
      id,
      actor_type: "agent",
      actor_id: "agent-1",
      created_at: now,
      action: "status_changed",
      details: { from: "todo", to: issue.status },
      issue,
    });
    const calls: { kind?: string; issue?: string }[] = [];
    apiRef.current = {
      listWorkspaceActivity: ((params: { kind?: string; issue?: string }) => {
        calls.push(params);
        const entries =
          params.kind === "status" ? [move("s-1", ship), move("s-2", fix)] : [move("a-1", ship), move("a-2", fix)];
        return Promise.resolve({ entries: params.issue ? entries.filter((e) => e.issue.id === params.issue) : entries });
      }) as () => Promise<unknown>,
    };
    renderPage();
    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;
    const statusChanges = screen.getByRole("heading", { name: "Status changes" }).closest("section")!;
    const rowOf = (section: HTMLElement, title: string) =>
      within(section).getByText(title).closest("a")!.parentElement!;
    await within(activity).findByText("Ship the dashboard");
    await within(statusChanges).findByText("Ship the dashboard");

    fireEvent.mouseEnter(rowOf(activity, "Ship the dashboard"));
    expect(rowOf(statusChanges, "Ship the dashboard").className).toContain("bg-brand/10");
    expect(rowOf(statusChanges, "Fix the reconnect").className).not.toContain("bg-brand/10");
    fireEvent.mouseLeave(rowOf(activity, "Ship the dashboard"));
    expect(rowOf(statusChanges, "Ship the dashboard").className).not.toContain("bg-brand/10");

    // The filter button sits beside the row link, so clicking the row still opens the issue.
    fireEvent.click(within(rowOf(activity, "Ship the dashboard")).getByRole("button", { name: "Show only this issue" }));
    expect(await screen.findByText("Filtered to")).toBeTruthy();
    await waitFor(() => expect(within(statusChanges).queryByText("Fix the reconnect")).toBeNull());
    expect(within(activity).queryByText("Fix the reconnect")).toBeNull();
    expect(calls.filter((c) => c.issue === "issue-1").map((c) => c.kind).sort()).toEqual(["all", "status"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear issue filter" }));
    expect(screen.queryByText("Filtered to")).toBeNull();
    expect(await within(statusChanges).findByText("Fix the reconnect")).toBeTruthy();
  });

  it("hides a section chosen in Customize", async () => {
    useOverviewLayoutStore.setState({ hidden: ["run_activity", "success_rate"] });
    renderPage();
    expect(screen.queryByText("Run activity")).toBeNull();
    expect(screen.queryByText("Success rate")).toBeNull();
    expect(screen.getByText("Recent activity")).toBeTruthy();
    useOverviewLayoutStore.setState({ hidden: [] });
  });
});
