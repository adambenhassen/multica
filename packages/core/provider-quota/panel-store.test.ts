// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useProviderQuotaPanelStore } from "./panel-store";

describe("useProviderQuotaPanelStore", () => {
  beforeEach(() => useProviderQuotaPanelStore.setState({ collapsed: null }));

  it("has no choice until the viewer makes one", () => {
    expect(useProviderQuotaPanelStore.getState().collapsed).toBeNull();
    useProviderQuotaPanelStore.getState().setCollapsed(true);
    expect(useProviderQuotaPanelStore.getState().collapsed).toBe(true);
    useProviderQuotaPanelStore.getState().setCollapsed(false);
    expect(useProviderQuotaPanelStore.getState().collapsed).toBe(false);
  });

  it("restores only a saved boolean", () => {
    const merge = useProviderQuotaPanelStore.persist.getOptions().merge!;
    const current = useProviderQuotaPanelStore.getState();
    expect(merge(undefined, current)).toMatchObject({ collapsed: null });
    expect(merge({ collapsed: "yes" }, current)).toMatchObject({ collapsed: null });
    expect(merge({ collapsed: true }, current)).toMatchObject({ collapsed: true });
    expect(merge({ collapsed: false }, current)).toMatchObject({ collapsed: false });
  });
});
