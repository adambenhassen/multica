"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

export interface OverviewLayoutState {
  /** The Activity feed mixes comments in with status changes. */
  showComments: boolean;
  toggleComments: () => void;
}

const stateStorage = defaultStorage as unknown as StateStorage;

// A per-device view preference, like the other view stores: it is the same in
// every workspace, so it is not workspace-scoped.
export const useOverviewLayoutStore = create<OverviewLayoutState>()(
  persist(
    (set) => ({
      showComments: false,
      toggleComments: () => set((state) => ({ showComments: !state.showComments })),
    }),
    {
      name: "multica_dashboard_layout",
      storage: createJSONStorage(() => stateStorage),
      // Older builds saved other keys here (hidden sections, project labels);
      // keep only what this build reads.
      merge: (persisted, current) => ({
        ...current,
        showComments: (persisted as { showComments?: unknown } | undefined)?.showComments === true,
      }),
    },
  ),
);
