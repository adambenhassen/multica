import { infiniteQueryOptions, keepPreviousData, queryOptions, type InfiniteData } from "@tanstack/react-query";
import { api } from "../api";
import type { WorkspaceActivityKind, WorkspaceActivityResponse } from "../types";

/**
 * What a Dashboard feed shows. `to` narrows the status feed to changes into
 * those status keys (empty keeps every change); `issues` and `project` (UUIDs)
 * keep those issues' history (empty keeps every issue) or one project's.
 */
export interface ActivityFeedFilters {
  kind?: WorkspaceActivityKind;
  to?: readonly string[];
  issues?: readonly string[];
  project?: string | null;
}

export const overviewKeys = {
  all: (wsId: string) => ["overview", wsId] as const,
  activityAll: (wsId: string) => [...overviewKeys.all(wsId), "activity"] as const,
  activity: (wsId: string, { kind = "all", to = [], issues = [], project = null }: ActivityFeedFilters = {}) =>
    [...overviewKeys.activityAll(wsId), kind, issues, project, ...to] as const,
  // Under the feed prefix, so the same activity events refresh it.
  activeIssues: (wsId: string, ids: readonly string[], project: string | null) =>
    [...overviewKeys.activityAll(wsId), "active-issues", project, ...ids] as const,
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

/** The workspace feed, newest first, narrowed by `filters`. */
export function workspaceActivityOptions(wsId: string, filters: ActivityFeedFilters = {}) {
  const { kind = "all", to = [], issues = [], project = null } = filters;
  return infiniteQueryOptions({
    queryKey: overviewKeys.activity(wsId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.listWorkspaceActivity({
        limit: WORKSPACE_ACTIVITY_LIMIT,
        kind,
        to,
        issues,
        project: project ?? undefined,
        before: pageParam ?? undefined,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    select: (data: InfiniteData<WorkspaceActivityResponse, string | null>) =>
      uniqueById(data.pages.flatMap((page) => page.entries)),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * The issues behind the given ids (the ones agents are working on right now,
 * from the live task snapshot), optionally narrowed to one project. An empty
 * id list is an empty result, not every issue.
 */
export function activeIssuesOptions(wsId: string, ids: readonly string[], project: string | null) {
  return queryOptions({
    queryKey: overviewKeys.activeIssues(wsId, ids, project),
    queryFn: () =>
      ids.length === 0
        ? Promise.resolve([])
        : api
            .listIssues({ ids: [...ids], project_ids: project ? [project] : undefined, limit: ids.length })
            .then((res) => res.issues),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
