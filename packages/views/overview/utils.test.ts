// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentPresenceDetail } from "@multica/core/agents";
import type { AgentTask, IssueStatusCategory, WorkspaceActivityEntry } from "@multica/core/types";
import {
  coalesceFeed,
  commentExcerpt,
  groupFeedByDay,
  fillRunSeries,
  pickRunCards,
  successRateSeries,
  successTone,
  summarizeAgents,
  summarizeIssueFacet,
} from "./utils";

describe("fillRunSeries", () => {
  it("zero-fills every day of the window, oldest first", () => {
    const series = fillRunSeries(
      [{ date: "2026-10-10", total_seconds: 0, task_count: 5, failed_count: 1, cancelled_count: 1 }],
      "2026-10-11",
      3,
    );
    expect(series.map((d) => d.date)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(series[0]).toMatchObject({ completed: 0, failed: 0, cancelled: 0 });
    expect(series[1]).toMatchObject({ completed: 3, failed: 1, cancelled: 1 });
  });
});

describe("successRateSeries", () => {
  it("ignores cancelled runs and leaves days without an outcome empty", () => {
    const rates = successRateSeries([
      { date: "a", label: "a", completed: 3, failed: 1, cancelled: 10 },
      { date: "b", label: "b", completed: 0, failed: 0, cancelled: 2 },
    ]);
    expect(rates.map((r) => r.rate)).toEqual([75, null]);
  });

  it.each([
    [100, "success"],
    [80, "success"],
    [79, "warning"],
    [50, "warning"],
    [49, "destructive"],
  ] as const)("tones %i%% as %s", (rate, tone) => {
    expect(successTone(rate)).toBe(tone);
  });
});

describe("summarizeAgents", () => {
  const detail = (over: Partial<AgentPresenceDetail>): AgentPresenceDetail => ({
    availability: "online",
    workload: "idle",
    runningCount: 0,
    queuedCount: 0,
    capacity: 1,
    ...over,
  });

  it("counts live agents and skips archived ones", () => {
    expect(
      summarizeAgents([
        detail({ workload: "working" }),
        detail({ workload: "queued" }),
        detail({ availability: "unstable" }),
        detail({ availability: "offline", workload: "queued" }),
        detail({ availability: "archived", workload: "working" }),
      ]),
    ).toEqual({ online: 2, offline: 2, working: 1, queued: 2 });
  });
});

describe("summarizeIssueFacet", () => {
  const categories: Record<string, IssueStatusCategory> = {
    backlog: "unstarted",
    todo: "unstarted",
    in_progress: "started",
    in_review: "started",
    blocked: "started",
    qa: "started",
    done: "done",
  };

  it("resolves custom statuses and keeps backlog and blocked out of progress", () => {
    expect(
      summarizeIssueFacet(
        [
          { key: "backlog", count: 9 },
          { key: "todo", count: 4 },
          { key: "in_progress", count: 3 },
          { key: "in_review", count: 1 },
          { key: "qa", count: 2 },
          { key: "blocked", count: 5 },
          { key: "done", count: 7 },
        ],
        (key) => categories[key] ?? "unstarted",
      ),
    ).toEqual({ inProgress: 6, todo: 4, blocked: 5 });
  });
});

describe("pickRunCards", () => {
  const task = (id: string, status: AgentTask["status"], over: Partial<AgentTask> = {}) =>
    ({ id, status, agent_id: "a", issue_id: "", completed_at: null, ...over }) as AgentTask;

  it("puts active runs first, then the newest finished, without chat runs", () => {
    const picked = pickRunCards(
      [
        task("old", "completed", { completed_at: "2026-10-01T00:00:00Z" }),
        task("queued", "queued"),
        task("chat", "running", { chat_session_id: "s" }),
        task("new", "failed", { completed_at: "2026-10-02T00:00:00Z" }),
        task("running", "running"),
      ],
      4,
    );
    expect(picked.map((t) => t.id)).toEqual(["running", "queued", "new", "old"]);
  });
});

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
