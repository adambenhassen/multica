/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { overviewKeys } from "../overview/queries";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));

vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

function createRecordingWs() {
  const handlers: Record<string, (p: unknown) => void> = {};
  const ws = {
    on: vi.fn((event: string, handler: (p: unknown) => void) => {
      handlers[event] = handler;
      return () => {};
    }),
    onAny: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  } as unknown as WSClient;
  return { ws, handlers };
}

const stores = {
  authStore: Object.assign(() => ({}), {
    getState: () => ({ user: { id: "u1" } }),
    subscribe: () => () => {},
    setState: () => {},
    destroy: () => {},
  }),
} as unknown as RealtimeSyncStores;

describe("useRealtimeSync — Dashboard activity feed", () => {
  let qc: QueryClient;
  const feedKey = overviewKeys.activity("ws-1", 10);

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(feedKey, { entries: [] });
  });

  afterEach(() => {
    qc.clear();
    vi.useRealTimers();
  });

  function mount() {
    const { ws, handlers } = createRecordingWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
    return handlers;
  }

  it("refreshes once, one second after the first of a burst of activity events", () => {
    const handlers = mount();
    const spy = vi.spyOn(qc, "invalidateQueries");

    handlers["activity:created"]?.({ issue_id: "issue-1", entry: {} });
    vi.advanceTimersByTime(600);
    handlers["activity:created"]?.({ issue_id: "issue-2", entry: {} });
    expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(false);

    vi.advanceTimersByTime(400);
    expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(true);
    const feedCalls = spy.mock.calls.filter(
      ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(overviewKeys.activityAll("ws-1")),
    );
    expect(feedCalls).toHaveLength(1);
  });

  it("refreshes after an issue is deleted", () => {
    const handlers = mount();
    handlers["issue:deleted"]?.({ issue_id: "issue-1" });
    vi.advanceTimersByTime(1_000);
    expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(true);
  });
});
