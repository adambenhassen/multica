"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

/** Dashboard sections a viewer can hide, in page order. */
export const OVERVIEW_SECTIONS = [
  "agents",
  "metrics",
  "run_activity",
  "success_rate",
  "activity",
  "issues",
] as const;
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

export interface OverviewLayoutState {
  hidden: OverviewSection[];
  toggleSection: (section: OverviewSection) => void;
  showAll: () => void;
}

const stateStorage = defaultStorage as unknown as StateStorage;

// A per-device layout preference, like the other view stores: which sections
// a viewer wants is the same in every workspace, so it is not workspace-scoped.
export const useOverviewLayoutStore = create<OverviewLayoutState>()(
  persist(
    (set) => ({
      hidden: [],
      toggleSection: (section) =>
        set((state) => ({
          hidden: state.hidden.includes(section)
            ? state.hidden.filter((s) => s !== section)
            : [...state.hidden, section],
        })),
      showAll: () => set({ hidden: [] }),
    }),
    {
      name: "multica_dashboard_layout",
      storage: createJSONStorage(() => stateStorage),
      // A section a newer build stops shipping must not linger as hidden.
      merge: (persisted, current) => {
        const hidden = (persisted as { hidden?: unknown } | undefined)?.hidden;
        return {
          ...current,
          hidden: Array.isArray(hidden)
            ? hidden.filter((s): s is OverviewSection => OVERVIEW_SECTIONS.includes(s as OverviewSection))
            : [],
        };
      },
    },
  ),
);
