// @vitest-environment node
import { describe, expect, it } from "vitest";
import { overviewKeys, workspaceActivityOptions } from "./queries";

describe("overview query keys", () => {
  it("scopes the activity feed by workspace under the shared prefix", () => {
    expect(workspaceActivityOptions("ws-1", "comments").queryKey).toEqual(["overview", "ws-1", "activity", "comments"]);
    expect(overviewKeys.activityAll("ws-2")).toEqual(["overview", "ws-2", "activity"]);
  });

  it("keys each status-change filter separately under the feed prefix", () => {
    expect(workspaceActivityOptions("ws-1", "status", ["blocked"]).queryKey).toEqual([
      "overview",
      "ws-1",
      "activity",
      "status",
      "blocked",
    ]);
  });
});
