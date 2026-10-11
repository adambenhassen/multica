// @vitest-environment node
import { describe, expect, it } from "vitest";
import { overviewKeys, recentIssuesOptions, workspaceActivityOptions } from "./queries";

describe("overview query keys", () => {
  it("scopes the activity feed by workspace under the shared prefix", () => {
    expect(workspaceActivityOptions("ws-1", "comments").queryKey).toEqual(["overview", "ws-1", "activity", "comments"]);
    expect(overviewKeys.activityAll("ws-2")).toEqual(["overview", "ws-2", "activity"]);
  });

  it("keys each recent-issues tab separately under one invalidation prefix", () => {
    expect(recentIssuesOptions("ws-1", "blocked").queryKey).toEqual(["overview", "ws-1", "issues", "blocked"]);
    expect(overviewKeys.issuesAll("ws-1")).toEqual(["overview", "ws-1", "issues"]);
  });
});
