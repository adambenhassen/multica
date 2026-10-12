"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

/** What the Activity feed shows beyond status changes and creations. */
export interface OverviewLayoutState {
  /** Mix comments into the All tab. */
  showComments: boolean;
  /** Mix other issue changes (reassigned, edited) into the All tab. */
  showOther: boolean;
  /** Keep only each issue's latest status change. */
  latestOnly: boolean;
  toggleComments: () => void;
  toggleOther: () => void;
  toggleLatestOnly: () => void;
}

const stateStorage = defaultStorage as unknown as StateStorage;

// A per-device view preference, like the other view stores: it is the same in
// every workspace, so it is not workspace-scoped.
export const useOverviewLayoutStore = create<OverviewLayoutState>()(
  persist(
    (set) => ({
      showComments: false,
      showOther: false,
      latestOnly: true,
      toggleComments: () => set((state) => ({ showComments: !state.showComments })),
      toggleOther: () => set((state) => ({ showOther: !state.showOther })),
      toggleLatestOnly: () => set((state) => ({ latestOnly: !state.latestOnly })),
    }),
    {
      name: "multica_dashboard_layout",
      storage: createJSONStorage(() => stateStorage),
      // Older builds saved other keys here (hidden sections, project labels);
      // keep only what this build reads. Only a saved true turns comments or
      // other changes on, and only a saved false turns latest-only off.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...current,
          showComments: saved.showComments === true,
          showOther: saved.showOther === true,
          latestOnly: saved.latestOnly !== false,
        };
      },
    },
  ),
);
