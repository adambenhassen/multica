import { infiniteQueryOptions, keepPreviousData, type InfiniteData } from "@tanstack/react-query";
import { api } from "../api";
import type { WorkspaceActivityKind, WorkspaceActivityResponse } from "../types";

export const overviewKeys = {
  all: (wsId: string) => ["overview", wsId] as const,
  activityAll: (wsId: string) => [...overviewKeys.all(wsId), "activity"] as const,
  activity: (wsId: string, kind: WorkspaceActivityKind, to: readonly string[] = []) =>
    [...overviewKeys.activityAll(wsId), kind, ...to] as const,
};

// The feed endpoint caps a page at 50; the Dashboard list scrolls inside it.
export const WORKSPACE_ACTIVITY_LIMIT = 50;

// Every feed is paged: the Dashboard loads the next page as the reader
// scrolls near the end. WS events invalidate the whole prefix, which refetches
// the pages already loaded.

// Pages can overlap when rows arrive between fetches; the first copy of a row
// wins.
function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * The workspace feed, newest first. `to` narrows the status feed to changes
 * into those status keys; an empty list keeps every status change.
 */
export function workspaceActivityOptions(
  wsId: string,
  kind: WorkspaceActivityKind = "all",
  to: readonly string[] = [],
) {
  return infiniteQueryOptions({
    queryKey: overviewKeys.activity(wsId, kind, to),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.listWorkspaceActivity({ limit: WORKSPACE_ACTIVITY_LIMIT, kind, to, before: pageParam ?? undefined }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    select: (data: InfiniteData<WorkspaceActivityResponse, string | null>) =>
      uniqueById(data.pages.flatMap((page) => page.entries)),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
