// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() => useOverviewLayoutStore.setState({ hidden: [], showProjects: false }));

  it("toggles a section off and back on", () => {
    const { toggleSection } = useOverviewLayoutStore.getState();
    toggleSection("run_activity");
    expect(useOverviewLayoutStore.getState().hidden).toEqual(["run_activity"]);
    toggleSection("run_activity");
    expect(useOverviewLayoutStore.getState().hidden).toEqual([]);
  });

  it("drops unknown sections when restoring a saved layout", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const restored = merge({ hidden: ["metrics", "retired_section", 3] }, useOverviewLayoutStore.getState());
    expect(restored.hidden).toEqual(["metrics"]);
  });

  it("restores project labels only from a saved true", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge({ hidden: [], showProjects: true }, current).showProjects).toBe(true);
    expect(merge({ hidden: [], showProjects: "yes" }, current).showProjects).toBe(false);
    // The retired compact toggle is dropped.
    expect(merge({ hidden: [], compact: true }, current)).not.toHaveProperty("compact");
  });

  it("toggles project labels", () => {
    useOverviewLayoutStore.getState().toggleProjects();
    expect(useOverviewLayoutStore.getState().showProjects).toBe(true);
  });
});
