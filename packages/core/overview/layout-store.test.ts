// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() =>
    useOverviewLayoutStore.setState({ showComments: false, showOther: false, latestOnly: false, showWaiting: false }),
  );

  it("toggles each display choice on its own", () => {
    const s = useOverviewLayoutStore.getState();
    s.toggleComments();
    s.toggleLatestOnly();
    expect(useOverviewLayoutStore.getState()).toMatchObject({ showComments: true, showOther: false, latestOnly: true });
    useOverviewLayoutStore.getState().toggleOther();
    useOverviewLayoutStore.getState().toggleComments();
    expect(useOverviewLayoutStore.getState()).toMatchObject({ showComments: false, showOther: true, latestOnly: true });
  });

  it("toggles waiting reasons on every tab, off by default", () => {
    useOverviewLayoutStore.getState().toggleWaiting();
    expect(useOverviewLayoutStore.getState().showWaiting).toBe(true);
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge(undefined, current)).toMatchObject({ showWaiting: false });
    expect(merge({ showWaiting: "yes" }, current)).toMatchObject({ showWaiting: false });
    expect(merge({ showWaiting: true }, current)).toMatchObject({ showWaiting: true });
  });

  it("defaults to hiding earlier moves", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge(undefined, current)).toMatchObject({ showComments: false, showOther: false, latestOnly: true });
    expect(merge({ latestOnly: "no" }, current)).toMatchObject({ latestOnly: true });
    expect(merge({ latestOnly: false }, current)).toMatchObject({ latestOnly: false });
  });

  it("restores choices from saved values and drops retired keys", () => {
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
