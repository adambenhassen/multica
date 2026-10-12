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
    getActorInitials: () => "B",
    getActorAvatarUrl: () => null,
  }),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ enableHoverCard, actorId }: { enableHoverCard?: boolean; actorId: string }) => (
    <span data-testid="avatar" data-actor={actorId} data-hover-card={enableHoverCard ? "on" : "off"} />
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
  useOverviewLayoutStore.setState({ showComments: false, showOther: false, latestOnly: false });
});

const NOW = new Date().toISOString();
const SHIP = { id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "done" };
const FIX = { id: "issue-2", identifier: "MUL-2", title: "Fix the reconnect", status: "todo" };

function move(id: string, issue: { id: string; identifier: string; title: string; status: string; project_id?: string }) {
  return {
    type: "activity",
    id,
    actor_type: "agent",
    actor_id: "agent-1",
    created_at: NOW,
    action: "status_changed",
    details: { from: "in_review", to: issue.status },
    issue,
  };
}

function comment(id: string, issue: typeof SHIP, content: string) {
  return { type: "comment", id, actor_type: "agent", actor_id: "agent-1", created_at: NOW, content, issue };
}

type FeedCall = { kind?: string; to?: string[]; issue?: string; project?: string };

/** Scripts the feed endpoint and records every call's parameters. */
function scriptFeed(entries: (params: FeedCall) => unknown[]) {
  const calls: FeedCall[] = [];
  apiRef.current.listWorkspaceActivity = ((params: FeedCall) => {
    calls.push(params);
    return Promise.resolve({ entries: entries(params) });
  }) as () => Promise<unknown>;
  return calls;
}

const feed = () => screen.getByRole("heading", { name: "Recent activity" }).closest("section")!;

describe("OverviewPage", () => {
  it("shows one Recent activity feed of status changes, with an empty state", async () => {
    const calls = scriptFeed(() => []);
    renderPage();

    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Recent activity"]);
    expect(await within(feed()).findByText("No status changes yet")).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ kind: "status", to: [] });
    // One list: no split handle, no section picker, no project-label toggle.
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Project labels" })).toBeNull();
  });

  it("links rows to their issues", async () => {
    scriptFeed(() => [move("a-1", SHIP)]);
    renderPage();

    const row = (await within(feed()).findByText("Ship the dashboard")).closest("a")!;
    expect(row.getAttribute("href")).toBe("/acme/issues/issue-1");
    expect(within(row).getByText("MUL-1")).toBeTruthy();
    expect(within(row).getAllByText("Builder").length).toBeGreaterThan(0);
  });

  it("reports a failed load instead of showing it as empty, and retries it", async () => {
    let n = 0;
    apiRef.current.listWorkspaceActivity = () => {
      n += 1;
      return n === 1 ? Promise.reject(new Error("404")) : Promise.resolve({ entries: [] });
    };
    renderPage();

    expect(await within(feed()).findByText("Couldn't load")).toBeTruthy();
    expect(within(feed()).queryByText("No status changes yet")).toBeNull();
    fireEvent.click(within(feed()).getByRole("button", { name: "Try again" }));
    expect(await within(feed()).findByText("No status changes yet")).toBeTruthy();
  });

  it("filters by the status a change went into", async () => {
    const status = (key: string, category: string, position: number) => ({
      id: key, workspace_id: "ws-1", key, name: key, description: "", category, color: "#888888",
      icon: null, is_system: false, position, archived_at: null, created_at: "", updated_at: "",
    });
    apiRef.current.listIssueStatuses = () =>
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
      });
    const calls = scriptFeed(() => []);
    renderPage();

    await within(feed()).findByText("No status changes yet");
    fireEvent.click(within(feed()).getByRole("button", { name: "Blocked" }));
    await within(feed()).findByText("No changes into this status");
    expect(calls.at(-1)).toMatchObject({ kind: "status", to: ["blocked"] });

    fireEvent.click(within(feed()).getByRole("button", { name: "In progress" }));
    await waitFor(() => expect(calls.at(-1)?.to).toEqual(["in_progress", "qa"]));

    fireEvent.click(within(feed()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls.at(-1)?.to).toEqual(["done"]));
  });

  it("shows failed agent runs on their own tab", async () => {
    const calls = scriptFeed((p) => (p.kind === "failures" ? [] : [move("a-1", SHIP)]));
    renderPage();

    await within(feed()).findByText("Ship the dashboard");
    fireEvent.click(within(feed()).getByRole("button", { name: "Failed runs" }));
    expect(await within(feed()).findByText("No failed runs")).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ kind: "failures", to: [] });
  });

  it("mixes comments and other changes into All from the Display menu, and remembers them", async () => {
    const reassigned = { type: "activity", id: "o-1", actor_type: "agent", actor_id: "agent-1", created_at: NOW, action: "assignee_changed", details: {}, issue: FIX };
    const calls = scriptFeed((p) => {
      if (p.kind === "status_comments") return [comment("c-1", FIX, "Waiting for green CI"), move("a-1", SHIP)];
      if (p.kind === "changes") return [reassigned, move("a-1", SHIP)];
      return [move("a-1", SHIP)];
    });
    renderPage();
    await within(feed()).findByText("Ship the dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Comments" }));
    expect(useOverviewLayoutStore.getState().showComments).toBe(true);
    const row = (await within(feed()).findByText("Fix the reconnect")).closest("a")!;
    expect(row.getAttribute("href")).toBe("/acme/issues/issue-2#comment-c-1");
    // The comment's text is its icon's tooltip, and the visible text of a wide list.
    expect(row.querySelector('[title="commented: “Waiting for green CI”"]')).not.toBeNull();
    expect(within(row).getByText("Waiting for green CI").className).toContain("@4xl:inline");
    expect(calls.at(-1)).toMatchObject({ kind: "status_comments" });

    // Comments off, other changes on: every issue change without comments.
    useOverviewLayoutStore.setState({ showComments: false, showOther: true });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ kind: "changes" }));
    // Both on: the whole feed.
    useOverviewLayoutStore.setState({ showComments: true, showOther: true });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ kind: "all" }));

    // Neither is a move into a status: the status tabs stay status-only.
    fireEvent.click(within(feed()).getByRole("button", { name: "Blocked" }));
    await waitFor(() => expect(calls.at(-1)?.kind).toBe("status"));
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
  });

  it("keeps a repeat count inside the action column, so the row stays aligned", async () => {
    const failed = (id: string) => ({
      type: "activity", id, actor_type: "agent", actor_id: "agent-1", created_at: NOW, action: "task_failed", details: {}, issue: SHIP,
    });
    scriptFeed((p) => (p.kind === "failures" ? [failed("f-1"), failed("f-2")] : []));
    renderPage();
    fireEvent.click(await within(feed()).findByRole("button", { name: "Failed runs" }));
    const row = (await within(feed()).findByText("Ship the dashboard")).closest("a")!;
    const count = within(row).getByText("×2");
    // The count sits in the fixed-width action column, next to the action's words.
    expect(count.parentElement!.className).toContain("w-14");
    expect(count.parentElement!.className).toContain("@4xl:w-56");
  });

  it("keeps only each issue's latest move when asked", async () => {
    const older = { ...move("a-2", SHIP), details: { from: "todo", to: "in_review" } };
    scriptFeed(() => [move("a-1", SHIP), move("a-3", FIX), older]);
    renderPage();
    await within(feed()).findAllByText("Ship the dashboard");
    expect(within(feed()).getAllByText("Ship the dashboard")).toHaveLength(2);

    useOverviewLayoutStore.setState({ latestOnly: true });
    await waitFor(() => expect(within(feed()).getAllByText("Ship the dashboard")).toHaveLength(1));
    expect(within(feed()).getByText("Fix the reconnect")).toBeTruthy();
  });

  it("counts the agents running now in the header, and opens the Active tab from it", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-2", agent_id: "agent-2", issue_id: "", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-3", agent_id: "agent-3", issue_id: "issue-2", status: "queued", started_at: null, created_at: NOW },
      ]);
    apiRef.current.listIssues = () =>
      Promise.resolve({ issues: [{ id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "in_progress" }], total: 1 });
    scriptFeed(() => []);
    renderPage();

    const chip = await screen.findByRole("button", { name: "2 agents working" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(within(feed()).getByRole("button", { name: "Active", pressed: true })).toBeTruthy();
    expect(await within(feed()).findByText("Ship the dashboard")).toBeTruthy();
  });

  it("lists the issues agents are working on now on the Active tab", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-2", agent_id: "agent-2", issue_id: "issue-2", status: "queued", started_at: null, created_at: NOW },
      ]);
    const issueCalls: { ids?: string[] }[] = [];
    apiRef.current.listIssues = ((params: { ids?: string[] }) => {
      issueCalls.push(params);
      return Promise.resolve({
        issues: [{ id: "issue-1", identifier: "MUL-1", title: "Ship the dashboard", status: "in_progress", project_id: null }],
        total: 1,
      });
    }) as () => Promise<unknown>;
    scriptFeed(() => []);
    renderPage();

    fireEvent.click(await within(feed()).findByRole("button", { name: "Active" }));
    const row = (await within(feed()).findByText("Ship the dashboard")).closest("a")!;
    expect(row.getAttribute("href")).toBe("/acme/issues/issue-1");
    expect(within(row).getByText("Working now: Builder")).toBeTruthy();
    // Only running tasks count: the queued one's issue is not asked for.
    expect(issueCalls.at(-1)?.ids).toEqual(["issue-1"]);
  });

  it("shows each event on one line and names what it hides on hover", async () => {
    scriptFeed(() => [move("a-1", SHIP)]);
    renderPage();

    const row = (await within(feed()).findByText("Ship the dashboard")).closest("a")!;
    // The move as icons, then the avatar. Each name has a screen-reader copy
    // for narrow lists and a visible one a wide (56rem) list shows instead.
    expect(within(row).getByLabelText("→")).toBeTruthy();
    for (const name of ["Done", "Builder"]) {
      const classes = within(row).getAllByText(name).map((el) => el.className);
      expect(classes.some((c) => c.includes("sr-only") && c.includes("@4xl:hidden"))).toBe(true);
      expect(classes.some((c) => c.includes("hidden") && c.includes("@4xl:inline"))).toBe(true);
    }
    // Hover names the rest: the full title, who acted, the action and each status.
    expect(within(row).getByText("Ship the dashboard").getAttribute("title")).toBe("Ship the dashboard");
    expect(within(row).getByTestId("avatar").dataset.hoverCard).toBe("on");
    expect(row.querySelector('[title="marked it Done"]')).not.toBeNull();
    expect(row.querySelector('[title="In Review"]')).not.toBeNull();
    expect(row.querySelector('[title="Done"]')).not.toBeNull();
  });

  it("labels rows with their project and filters to a project", async () => {
    apiRef.current.listProjects = () =>
      Promise.resolve({ projects: [{ id: "project-1", title: "Teagram server", icon: null }], total: 1 });
    const calls = scriptFeed(() => [move("a-1", { ...SHIP, project_id: "project-1" })]);
    renderPage();

    expect(await within(feed()).findByText("Teagram server")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Teagram server" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ kind: "status", project: "project-1" }));
  });

  it("shows the agents working on each row's issue", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running" },
        { id: "t-2", agent_id: "agent-2", issue_id: "issue-1", status: "queued" },
        { id: "t-3", agent_id: "agent-1", issue_id: "issue-2", status: "completed" },
      ]);
    scriptFeed(() => [move("a-1", SHIP), move("a-2", FIX)]);
    renderPage();

    const ship = (await within(feed()).findByText("Ship the dashboard")).closest("a")!;
    expect(await within(ship).findByText("Working now: Builder")).toBeTruthy();
    // Only running tasks count: a queued task has not started.
    expect(ship.querySelectorAll('[data-actor="agent-2"]')).toHaveLength(0);
    const fix = within(feed()).getByText("Fix the reconnect").closest("a")!;
    expect(within(fix).queryByText(/Working now/)).toBeNull();
  });

  it("tints an issue's rows on hover and filters the feed to it", async () => {
    const calls = scriptFeed((p) => {
      const entries = [move("a-1", SHIP), move("a-2", FIX), move("a-3", SHIP)];
      return p.issue ? entries.filter((e) => e.issue.id === p.issue) : entries;
    });
    renderPage();
    const rows = (title: string) => within(feed()).getAllByText(title).map((el) => el.closest("a")!.parentElement!);
    await within(feed()).findAllByText("Ship the dashboard");

    fireEvent.mouseEnter(rows("Ship the dashboard")[0]!);
    expect(rows("Ship the dashboard").every((r) => r.className.includes("bg-brand/10"))).toBe(true);
    expect(rows("Fix the reconnect")[0]!.className).not.toContain("bg-brand/10");
    fireEvent.mouseLeave(rows("Ship the dashboard")[0]!);
    expect(rows("Ship the dashboard")[1]!.className).not.toContain("bg-brand/10");

    // The filter button sits beside the row link, so clicking the row still opens the issue.
    fireEvent.click(within(rows("Ship the dashboard")[0]!).getByRole("button", { name: "Show only this issue" }));
    expect(await screen.findByText("Filtered to")).toBeTruthy();
    await waitFor(() => expect(within(feed()).queryByText("Fix the reconnect")).toBeNull());
    expect(calls.at(-1)).toMatchObject({ issue: "issue-1" });

    fireEvent.click(screen.getByRole("button", { name: "Clear issue filter" }));
    expect(screen.queryByText("Filtered to")).toBeNull();
    expect(await within(feed()).findByText("Fix the reconnect")).toBeTruthy();
  });
});
