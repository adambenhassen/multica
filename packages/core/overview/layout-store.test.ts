// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() => useOverviewLayoutStore.setState({ hidden: [] }));

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
});
