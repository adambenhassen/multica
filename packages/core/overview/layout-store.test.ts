// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() => useOverviewLayoutStore.setState({ showComments: false }));

  it("toggles comments in the feed", () => {
    useOverviewLayoutStore.getState().toggleComments();
    expect(useOverviewLayoutStore.getState().showComments).toBe(true);
    useOverviewLayoutStore.getState().toggleComments();
    expect(useOverviewLayoutStore.getState().showComments).toBe(false);
  });

  it("restores comments only from a saved true and drops retired keys", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge({ showComments: true }, current).showComments).toBe(true);
    expect(merge({ showComments: "yes" }, current).showComments).toBe(false);
    const restored = merge({ hidden: ["agents"], showProjects: true }, current);
    expect(restored).not.toHaveProperty("hidden");
    expect(restored).not.toHaveProperty("showProjects");
  });
});
