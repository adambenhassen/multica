// @vitest-environment node
import { describe, expect, it } from "vitest";
import { activeIssuesOptions, overviewKeys, workspaceActivityOptions } from "./queries";

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
