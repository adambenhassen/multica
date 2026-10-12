// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() => useOverviewLayoutStore.setState({ showComments: false, showOther: false, latestOnly: false }));

  it("toggles each display choice on its own", () => {
    const s = useOverviewLayoutStore.getState();
    s.toggleComments();
    s.toggleLatestOnly();
    expect(useOverviewLayoutStore.getState()).toMatchObject({ showComments: true, showOther: false, latestOnly: true });
    useOverviewLayoutStore.getState().toggleOther();
    useOverviewLayoutStore.getState().toggleComments();
    expect(useOverviewLayoutStore.getState()).toMatchObject({ showComments: false, showOther: true, latestOnly: true });
  });

  it("restores choices only from a saved true and drops retired keys", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge({ showComments: true, showOther: "yes", latestOnly: true }, current)).toMatchObject({
      showComments: true,
      showOther: false,
      latestOnly: true,
    });
    const restored = merge({ hidden: ["agents"], showProjects: true }, current);
    expect(restored).not.toHaveProperty("hidden");
    expect(restored).not.toHaveProperty("showProjects");
  });
});
