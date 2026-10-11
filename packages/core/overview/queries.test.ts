// @vitest-environment node
import { describe, expect, it } from "vitest";
import { overviewKeys, workspaceActivityOptions } from "./queries";

describe("overview query keys", () => {
  it("scopes the activity feed by workspace under the shared prefix", () => {
    expect(workspaceActivityOptions("ws-1", 10).queryKey).toEqual(["overview", "ws-1", "activity", 10]);
    expect(overviewKeys.activityAll("ws-2")).toEqual(["overview", "ws-2", "activity"]);
  });
});
