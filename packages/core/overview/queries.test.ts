// @vitest-environment node
import { describe, expect, it } from "vitest";
import { overviewKeys, workspaceActivityOptions } from "./queries";

describe("overview query keys", () => {
  it("scopes the activity feed by workspace under the shared prefix", () => {
    expect(workspaceActivityOptions("ws-1", { kind: "comments" }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "comments",
      null,
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
      null,
      null,
      "blocked",
    ]);
  });

  it("keys an issue's history and a project's feed separately from the whole feed", () => {
    expect(workspaceActivityOptions("ws-1", { issue: "issue-1" }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "all",
      "issue-1",
      null,
    ]);
    expect(workspaceActivityOptions("ws-1", { project: "project-1" }).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "all",
      null,
      "project-1",
    ]);
  });
});
