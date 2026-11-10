"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

/** Whether the sidebar's provider quota panel is folded to its summary line. */
export interface ProviderQuotaPanelState {
  /**
   * The viewer's choice. `null` until they make one: then the surface
   * decides (folded in a phone's nav sheet, open in a docked sidebar).
   */
  collapsed: boolean | null;
  setCollapsed: (collapsed: boolean) => void;
}

const stateStorage = defaultStorage as unknown as StateStorage;

// A per-device view preference, like the other view stores: it is the same in
// every workspace, so it is not workspace-scoped.
export const useProviderQuotaPanelStore = create<ProviderQuotaPanelState>()(
  persist(
    (set) => ({
      collapsed: null,
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    {
      name: "multica_provider_quota_panel",
      storage: createJSONStorage(() => stateStorage),
      // Only a saved boolean is a choice; anything else leaves it to the surface.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Record<string, unknown>;
        return { ...current, collapsed: typeof saved.collapsed === "boolean" ? saved.collapsed : null };
      },
    },
  ),
);
