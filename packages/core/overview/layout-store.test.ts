// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useOverviewLayoutStore } from "./layout-store";

describe("useOverviewLayoutStore", () => {
  beforeEach(() => useOverviewLayoutStore.setState({ hidden: [], compact: false }));

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

  it("restores compact rows only from a saved true", () => {
    const merge = useOverviewLayoutStore.persist.getOptions().merge!;
    const current = useOverviewLayoutStore.getState();
    expect(merge({ hidden: [], compact: true }, current).compact).toBe(true);
    expect(merge({ hidden: [], compact: "yes" }, current).compact).toBe(false);
    expect(merge({ hidden: [] }, current).compact).toBe(false);
  });

  it("toggles compact rows", () => {
    useOverviewLayoutStore.getState().toggleCompact();
    expect(useOverviewLayoutStore.getState().compact).toBe(true);
  });
});
