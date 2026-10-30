// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { AgentTask, IssueCIEntry, IssueStatusEntry, WakeupPreview, WorkspaceActivityEntry } from "@multica/core/types";
import {
  coalesceFeed,
  commentExcerpt,
  durationParts,
  waitingGroup,
  waitingIssues,
  groupFeedByDay,
  latestRowPerIssue,
  latestStatusChangePerIssue,
  statusChangeTargets,
} from "./utils";

describe("commentExcerpt", () => {
  it("reads as one line of plain text", () => {
    expect(
      commentExcerpt(
        "## Done\n\nMerged **#42** for [@Ada](mention://member/u1), see [docs](https://x).\n```go\nfmt.Println()\n```\n- keep issue_id intact ![shot](a.png)",
      ),
    ).toBe("Done Merged #42 for @Ada, see docs. keep issue_id intact");
  });
});

describe("feed shaping", () => {
  const entry = (id: string, over: Partial<WorkspaceActivityEntry> = {}): WorkspaceActivityEntry => ({
    type: "activity",
    id,
    actor_type: "member",
    actor_id: "u1",
    created_at: "2026-10-12T10:00:00Z",
    action: "description_updated",
    issue: { id: "i1", identifier: "MUL-1", title: "T", status: "todo" },
    ...over,
  });

  it("folds consecutive autosaves by the same actor on the same issue", () => {
    const out = coalesceFeed([
      entry("a"),
      entry("b"),
      entry("c", { actor_id: "u2" }),
      entry("d", { action: "status_changed" }),
      entry("e", { action: "status_changed" }),
    ]);
    expect(out.map((e) => [e.id, e.coalesced_count ?? 1])).toEqual([["a", 2], ["c", 1], ["d", 1], ["e", 1]]);
  });

  it("groups by calendar day in the viewer's timezone", () => {
    const groups = groupFeedByDay(
      [
        entry("late", { created_at: "2026-10-12T01:00:00Z" }),
        entry("early", { created_at: "2026-10-11T23:30:00Z" }),
      ],
      "Europe/Berlin",
    );
    expect(groups.map((g) => [g.day, g.entries.map((e) => e.id)])).toEqual([["2026-10-12", ["late", "early"]]]);
  });
});

describe("statusChangeTargets", () => {
  const entry = (key: string, category: string, archived = false) =>
    ({ key, category, archived_at: archived ? "2026-10-01T00:00:00Z" : null }) as IssueStatusEntry;
  const catalog = buildIssueStatusCatalog([
    entry("todo", "unstarted"),
    entry("in_progress", "started"),
    entry("qa", "started"),
    entry("blocked", "started"),
    entry("done", "done"),
    entry("shipped", "done", true),
    entry("cancelled", "closed"),
  ]);

  it("narrows by the category a change went into, keeping Blocked separate", () => {
    expect(statusChangeTargets("all", catalog)).toEqual([]);
    expect(statusChangeTargets("blocked", catalog)).toEqual(["blocked"]);
    expect(statusChangeTargets("in_progress", catalog)).toEqual(["in_progress", "qa"]);
    expect(statusChangeTargets("done", catalog)).toEqual(["done", "shipped"]);
    expect(statusChangeTargets("cancelled", catalog)).toEqual(["cancelled"]);
  });

  it("waits for the catalog, then falls back to built-ins when it fails", () => {
    expect(statusChangeTargets("in_progress", buildIssueStatusCatalog(undefined))).toBeNull();
    expect(statusChangeTargets("blocked", buildIssueStatusCatalog(undefined))).toEqual(["blocked"]);
    const failed = buildIssueStatusCatalog(undefined, { isError: true });
    expect(statusChangeTargets("in_progress", failed)).toEqual(["in_progress", "in_review"]);
    expect(statusChangeTargets("cancelled", failed)).toEqual(["cancelled"]);
  });
});

describe("latestStatusChangePerIssue", () => {
  const row = (id: string, issueId: string, over: Partial<WorkspaceActivityEntry> = {}) =>
    ({
      type: "activity",
      id,
      action: "status_changed",
      actor_type: "agent",
      actor_id: "a",
      created_at: "",
      issue: { id: issueId, identifier: issueId, title: "", status: "" },
      ...over,
    }) as WorkspaceActivityEntry;

  it("keeps each issue's newest move, counting its creation as a move, and every other row", () => {
    const entries = [
      row("s3", "i1"),
      row("c1", "i1", { type: "comment", action: undefined }),
      row("a1", "i1", { action: "assignee_changed" }),
      row("s2", "i2"),
      row("s1", "i1"),
      row("k1", "i1", { action: "created" }),
      row("k3", "i3", { action: "created" }),
    ];
    // i1's creation is an earlier move; i3 never moved, so its creation stays.
    expect(latestStatusChangePerIssue(entries).map((e) => e.id)).toEqual(["s3", "c1", "a1", "s2", "k3"]);
  });

  it("keeps each issue's newest row of any kind for one-row-per-issue lists", () => {
    const entries = [
      row("c1", "i1", { type: "comment", action: undefined }),
      row("s3", "i1"),
      row("s2", "i2"),
      row("k1", "i1", { action: "created" }),
    ];
    expect(latestRowPerIssue(entries).map((e) => e.id)).toEqual(["c1", "s2"]);
  });
});

describe("waitingIssues", () => {
  const task = (issue_id: string, status: AgentTask["status"], created_at = "2026-10-30T06:00:00Z") => ({ issue_id, status, created_at });
  const pr = { provider: "gitea", repo_owner: "acme", repo_name: "widget", number: 7, html_url: "" };
  const ci = (issue_id: string, state: IssueCIEntry["state"], issue_status = "in_review"): IssueCIEntry => ({
    issue_id, issue_status, state, since: "2026-10-30T05:00:00Z", pull_request: pr,
  });
  const open = () => false;

  it("reports a queued run with its earliest creation time", () => {
    const got = waitingIssues(
      [task("a", "queued", "2026-10-30T06:10:00Z"), task("a", "dispatched", "2026-10-30T06:05:00Z")],
      [],
      [],
      open,
    );
    expect(got.get("a")).toEqual({ kind: "run_queued", since: "2026-10-30T06:05:00Z" });
  });

  it("reports pending CI, and failed CI only when no run is active or queued", () => {
    const got = waitingIssues([task("c", "deferred")], [ci("b", "running"), ci("c", "failed"), ci("d", "failed")], [], open);
    expect(got.get("b")).toMatchObject({ kind: "ci_running", pullRequest: pr });
    expect(got.has("c")).toBe(false);
    expect(got.get("d")).toMatchObject({ kind: "ci_failed", since: "2026-10-30T05:00:00Z" });
  });

  it("tells queued CI from running CI and from the merge gate", () => {
    const got = waitingIssues([], [ci("a", "queued"), ci("b", "gate")], [], open);
    expect(got.get("a")).toMatchObject({ kind: "ci_queued", pullRequest: pr });
    expect(got.get("b")).toMatchObject({ kind: "ci_gate", pullRequest: pr });
  });

  it("prefers a queued run over CI", () => {
    expect(waitingIssues([task("a", "queued")], [ci("a", "running")], [], open).get("a")?.kind).toBe("run_queued");
  });

  it("leaves out issues an agent is running on", () => {
    const got = waitingIssues(
      [task("a", "running"), task("a", "queued"), task("b", "waiting_local_directory")],
      [ci("a", "running"), ci("b", "failed")],
      [],
      open,
    );
    expect(got.size).toBe(0);
  });

  it("leaves out CI on closed issues", () => {
    const got = waitingIssues([], [ci("a", "running", "done")], [], (status) => status === "done");
    expect(got.size).toBe(0);
  });

  it("reports a wakeup last, after runs and CI, and not while an agent runs", () => {
    const wake = (issue_id: string) => ({ issue_id, kind: "at", next_fire_at: "2026-10-30T09:00:00Z" }) as WakeupPreview;
    const got = waitingIssues(
      [task("b", "queued"), task("d", "running")],
      [ci("c", "failed")],
      [wake("a"), wake("b"), wake("c"), wake("d")],
      open,
    );
    expect(got.get("a")).toEqual({ kind: "wakeup", wakeup: wake("a") });
    expect(got.get("b")?.kind).toBe("run_queued");
    expect(got.get("c")?.kind).toBe("ci_failed");
    expect(got.has("d")).toBe(false);
  });

  it("ignores tasks without an issue", () => {
    expect(waitingIssues([task("", "queued")], [], [], open).size).toBe(0);
  });
});

describe("durationParts", () => {
  const MIN = 60_000;
  it.each([
    [90_000, { minutes: 1 }],
    [157 * MIN, { hours: 2, minutes: 37 }],
    [49 * 60 * MIN, { days: 2 }],
    [-5 * MIN, { minutes: 0 }],
  ] as const)("%s ms is %j", (ms, want) => {
    expect(durationParts(ms)).toEqual(want);
  });
});

describe("waitingGroup", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const pr = { provider: "gitea", repo_owner: "acme", repo_name: "widget", number: 7, html_url: "" };
  const wake = (next_fire_at: string | null) => ({ kind: "wakeup", wakeup: { next_fire_at } as WakeupPreview }) as const;
  it.each([
    [{ kind: "run_queued", since: "2026-10-30T11:00:00Z" } as const, "run_queued"],
    [{ kind: "ci_failed", since: null, pullRequest: pr } as const, "ci_failed"],
    [{ kind: "ci_gate", since: null, pullRequest: pr } as const, "ci_gate"],
    [wake("2026-10-30T11:59:00Z"), "wakeup_due"],
    [wake("2026-10-30T12:30:00Z"), "wakeup"],
    [wake(null), "wakeup"],
  ])("%j is %s", (reason, want) => {
    expect(waitingGroup(reason, now)).toBe(want);
  });
});
