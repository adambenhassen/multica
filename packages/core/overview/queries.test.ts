// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const listIssues = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { listIssues } }));

import { activeIssuesOptions, issueCIOptions, issueStatusCountOptions, overviewKeys, workspaceActivityOptions } from "./queries";

describe("overview query keys", () => {
  it("scopes the activity feed by workspace under the shared prefix", () => {
    expect(workspaceActivityOptions("ws-1", { kind: "comments" }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "comments",
      [],
      null,
    ]);
    expect(overviewKeys.activityAll("ws-2")).toEqual(["overview", "ws-2", "activity"]);
  });

  it("keys each status-change filter separately under the feed prefix", () => {
    expect(workspaceActivityOptions("ws-1", { kind: "status", to: ["blocked"] }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "status",
      [],
      null,
      "blocked",
    ]);
  });

  it("keys an issue's history and a project's feed separately from the whole feed", () => {
    expect(workspaceActivityOptions("ws-1", { issues: ["issue-1"] }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "all",
      ["issue-1"],
      null,
    ]);
    expect(workspaceActivityOptions("ws-1", { project: "project-1" }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "all",
      [],
      "project-1",
    ]);
  });

  it("keys the active-issue list under the feed prefix, so feed events refresh it", () => {
    expect(activeIssuesOptions("ws-1", ["i-1", "i-2"], "p-1").queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "active-issues",
      "p-1",
      "i-1",
      "i-2",
    ]);
  });
});

describe("current-status feed key", () => {
  it("keys the issues still in a status apart from every move into it", () => {
    const moves = workspaceActivityOptions("ws-1", { kind: "status", to: ["blocked"] }).queryKey;
    const current = workspaceActivityOptions("ws-1", { kind: "status", to: ["blocked"], current: true }).queryKey;
    expect(current).not.toEqual(moves);
    expect(current.slice(0, 3)).toEqual(overviewKeys.activityAll("ws-1"));
  });
});

describe("issue CI query key", () => {
  it("sits outside the feed prefix, so activity events do not refetch it", () => {
    const key = issueCIOptions("ws-1").queryKey;
    expect(key).toEqual(["overview", "ws-1", "issue-ci"]);
    expect(key.slice(0, 3)).not.toEqual(overviewKeys.activityAll("ws-1"));
  });
});

describe("issue status count", () => {
  const run = (statuses: string[], project: string | null) => {
    const options = issueStatusCountOptions("ws-1", statuses, project);
    return (options.queryFn as () => Promise<number>)();
  };

  it("sits under the feed prefix, so a status change's activity refreshes it", () => {
    expect(issueStatusCountOptions("ws-1", ["todo", "qa"], "p-1").queryKey).toEqual([
      "overview", "ws-1", "activity", "status-count", "p-1", "todo", "qa",
    ]);
  });

  it("reads the server's total for the statuses and project", async () => {
    listIssues.mockResolvedValueOnce({ issues: [{ id: "i-1" }], total: 42 });
    expect(await run(["in_progress", "qa"], "p-1")).toBe(42);
    expect(listIssues).toHaveBeenLastCalledWith({ statuses: ["in_progress", "qa"], project_ids: ["p-1"], limit: 1 });
  });

  it("counts none for no statuses without asking for every issue", async () => {
    listIssues.mockClear();
    expect(await run([], null)).toBe(0);
    expect(listIssues).not.toHaveBeenCalled();
  });
});
