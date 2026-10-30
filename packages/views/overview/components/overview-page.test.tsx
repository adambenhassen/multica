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

type FeedCall = { kind?: string; to?: string[]; issues?: string[]; project?: string };

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
    expect(count.parentElement!.className).toContain("@4xl:w-48");
  });

  it("shows a new issue as its icon and \"Issue created\"", async () => {
    const created = {
      type: "activity", id: "k-1", actor_type: "agent", actor_id: "agent-1", created_at: NOW, action: "created", details: {}, issue: FIX,
    };
    scriptFeed(() => [created]);
    renderPage();
    const row = (await within(feed()).findByText("Fix the reconnect")).closest("a")!;
    const words = within(row).getAllByText("Issue created");
    // Visible beside its icon in a wide list, in the fixed action column.
    expect(words.some((el) => el.className.includes("@4xl:inline") && el.closest('[class*="w-14"]'))).toBe(true);
    expect(row.querySelector('[title="Issue created"]')).not.toBeNull();
    expect(within(row).queryByText(/created this issue/)).toBeNull();
  });

  it("shows one row per issue on the Active tab, loading pages until each issue has one", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-2", agent_id: "agent-1", issue_id: "issue-2", status: "running", started_at: NOW, created_at: NOW },
      ]);
    // The busy issue fills the first page; the quiet one only shows on page two.
    const pages: Record<string, { entries: unknown[]; next_cursor: string | null }> = {
      first: { entries: [move("a-1", SHIP), move("a-2", SHIP), move("a-3", SHIP)], next_cursor: "c1" },
      c1: { entries: [move("a-4", FIX), move("a-5", SHIP)], next_cursor: "c2" },
      c2: { entries: [move("a-6", SHIP)], next_cursor: null },
    };
    const before: (string | undefined)[] = [];
    apiRef.current.listWorkspaceActivity = ((params: { issues?: string[]; before?: string }) => {
      if (!params.issues?.length) return Promise.resolve({ entries: [move("a-1", SHIP)], next_cursor: null });
      before.push(params.before);
      return Promise.resolve(pages[params.before ?? "first"]);
    }) as () => Promise<unknown>;
    renderPage();
    await within(feed()).findByText("Ship the dashboard");

    fireEvent.click(within(feed()).getByRole("button", { name: "Active" }));
    expect(await within(feed()).findByText("Fix the reconnect")).toBeTruthy();
    expect(within(feed()).getAllByText("Ship the dashboard")).toHaveLength(1);
    // It stops once both issues have a row: page three is never asked for.
    await new Promise((r) => setTimeout(r, 50));
    expect(before).toEqual([undefined, "c1"]);
  });

  it("keeps only each issue's latest move when asked", async () => {
    const older = { ...move("a-2", SHIP), details: { from: "todo", to: "in_review" } };
    const created = { ...move("k-1", SHIP), action: "created", details: {} };
    scriptFeed(() => [move("a-1", SHIP), move("a-3", FIX), older, created]);
    renderPage();
    await within(feed()).findAllByText("Ship the dashboard");
    expect(within(feed()).getAllByText("Ship the dashboard")).toHaveLength(3);

    // The older move and the creation both give way to the latest move.
    useOverviewLayoutStore.setState({ latestOnly: true });
    await waitFor(() => expect(within(feed()).getAllByText("Ship the dashboard")).toHaveLength(1));
    expect(within(feed()).queryAllByText("Issue created")).toHaveLength(0);
    expect(within(feed()).getByText("Fix the reconnect")).toBeTruthy();
  });

  it("counts the runs in progress now in the header, and opens the Active tab from it", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-2", agent_id: "agent-2", issue_id: "", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-3", agent_id: "agent-3", issue_id: "issue-2", status: "queued", started_at: null, created_at: NOW },
      ]);
    scriptFeed((p) => (p.issues?.includes("issue-1") ? [move("a-1", SHIP)] : []));
    renderPage();

    const chip = await screen.findByRole("button", { name: "2 runs working" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(within(feed()).getByRole("button", { name: "Active", pressed: true })).toBeTruthy();
    expect(await within(feed()).findByText("Ship the dashboard")).toBeTruthy();
  });

  it("shows the All feed for the issues agents are working on now on the Active tab", async () => {
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "running", started_at: NOW, created_at: NOW },
        { id: "t-2", agent_id: "agent-2", issue_id: "issue-2", status: "queued", started_at: null, created_at: NOW },
      ]);
    const calls = scriptFeed((p) =>
      p.issues?.length ? [move("a-1", SHIP)].filter((e) => p.issues!.includes(e.issue.id)) : [move("a-1", SHIP), move("a-2", FIX)],
    );
    renderPage();
    await within(feed()).findByText("Fix the reconnect");

    fireEvent.click(within(feed()).getByRole("button", { name: "Active" }));
    await waitFor(() => expect(within(feed()).queryByText("Fix the reconnect")).toBeNull());
    // Same rows as All, asked for only the issue with a running task.
    const row = within(feed()).getByText("Ship the dashboard").closest("a")!;
    expect(within(row).getByLabelText("→")).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ kind: "status", issues: ["issue-1"] });
  });

  it("says nobody is working when no agent runs, without asking for every issue", async () => {
    apiRef.current.getAgentTaskSnapshot = () => Promise.resolve([]);
    const calls = scriptFeed(() => [move("a-1", SHIP)]);
    renderPage();
    await within(feed()).findByText("Ship the dashboard");
    const before = calls.length;
    fireEvent.click(within(feed()).getByRole("button", { name: "Active" }));
    expect(await within(feed()).findByText("No agent is working on an issue right now")).toBeTruthy();
    expect(calls.length).toBe(before);
  });

  it("counts waiting issues in the header and shows what each waits on in the Waiting tab", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    apiRef.current.getAgentTaskSnapshot = () =>
      Promise.resolve([
        { id: "t-1", agent_id: "agent-1", issue_id: "issue-1", status: "queued", started_at: null, created_at: ago(10) },
        { id: "t-2", agent_id: "agent-1", issue_id: "issue-3", status: "running", started_at: NOW, created_at: NOW },
      ]);
    const pr = { provider: "gitea", repo_owner: "acme", repo_name: "widget", number: 7, html_url: "" };
    apiRef.current.getIssueCI = () =>
      Promise.resolve({
        issues: [
          { issue_id: "issue-2", issue_status: "in_review", state: "running", since: ago(37), pull_request: pr },
          // GitHub CI has no start time: the label carries no duration.
          { issue_id: "issue-5", issue_status: "in_review", state: "queued", since: null, pull_request: { ...pr, provider: "github" } },
          // An agent is running on issue-3: it is active, not waiting.
          { issue_id: "issue-3", issue_status: "in_review", state: "failed", since: ago(5), pull_request: pr },
        ],
      });
    const DOCS = { id: "issue-4", identifier: "MUL-4", title: "Update the docs", status: "todo" };
    const SPEC = { id: "issue-5", identifier: "MUL-5", title: "Write the spec", status: "in_review" };
    apiRef.current.listIssueWakeupSummaries = () =>
      Promise.resolve([
        {
          id: "w-1", issue_id: "issue-4", agent_id: "agent-1", agent_name: "Builder", kind: "at", mode: "once",
          event_types: [], interval_seconds: null, cron_expression: null, timezone: "UTC",
          next_fire_at: new Date(Date.now() + 125 * 60_000).toISOString(), active_count: 1, event_count: 0,
        },
      ]);
    const calls = scriptFeed((p) =>
      [move("a-1", SHIP), move("a-2", FIX), move("a-3", DOCS), move("a-4", SPEC)].filter((e) => !p.issues?.length || p.issues.includes(e.issue.id)),
    );
    renderPage();

    const chip = await screen.findByRole("button", { name: "4 waiting" });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(within(feed()).getByRole("button", { name: "Waiting", pressed: true })).toBeTruthy();
    expect(await within(feed()).findByText("CI running on acme/widget#7 for 37m")).toBeTruthy();
    expect(within(feed()).getByText("Run queued for 10m")).toBeTruthy();
    const docs = within(feed()).getByText("Update the docs").closest("a")!;
    expect(docs.querySelector("[data-waiting]")!.getAttribute("data-waiting")).toBe("wakeup");
    expect(within(docs).getByText("Wakes in 2h 4m")).toBeTruthy();
    const spec = within(feed()).getByText("Write the spec").closest("a")!;
    expect(within(spec).getByText("CI queued")).toBeTruthy();
    expect(within(spec).getByText("CI queued on acme/widget#7")).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ issues: ["issue-1", "issue-2", "issue-4", "issue-5"] });
    // The waiting cell sits before the move, not before the title.
    const row = within(feed()).getByText("Fix the reconnect").closest("a")!;
    const cell = row.querySelector("[data-waiting]")!;
    expect(cell.getAttribute("data-waiting")).toBe("ci_running");
    expect(cell.compareDocumentPosition(within(row).getByText("Fix the reconnect")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(cell.compareDocumentPosition(within(row).getByLabelText("→")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says nothing is waiting without asking for every issue", async () => {
    apiRef.current.getAgentTaskSnapshot = () => Promise.resolve([]);
    apiRef.current.getIssueCI = () => Promise.resolve({ issues: [] });
    apiRef.current.listIssueWakeupSummaries = () => Promise.resolve([]);
    const calls = scriptFeed(() => [move("a-1", SHIP)]);
    renderPage();
    await within(feed()).findByText("Ship the dashboard");
    expect(await screen.findByRole("button", { name: "0 waiting" })).toBeTruthy();
    const before = calls.length;
    fireEvent.click(within(feed()).getByRole("button", { name: "Waiting" }));
    expect(await within(feed()).findByText("Nothing is waiting on a run, CI, the merge gate or a wakeup")).toBeTruthy();
    expect(calls.length).toBe(before);
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
      return p.issues?.length ? entries.filter((e) => p.issues!.includes(e.issue.id)) : entries;
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
    expect(calls.at(-1)).toMatchObject({ issues: ["issue-1"] });

    fireEvent.click(screen.getByRole("button", { name: "Clear issue filter" }));
    expect(screen.queryByText("Filtered to")).toBeNull();
    expect(await within(feed()).findByText("Fix the reconnect")).toBeTruthy();
  });
});
