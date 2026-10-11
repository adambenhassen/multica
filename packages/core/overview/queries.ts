import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListIssuesParams, WorkspaceActivityKind } from "../types";

export const overviewKeys = {
  all: (wsId: string) => ["overview", wsId] as const,
  activityAll: (wsId: string) => [...overviewKeys.all(wsId), "activity"] as const,
  activity: (wsId: string, kind: WorkspaceActivityKind) =>
    [...overviewKeys.activityAll(wsId), kind] as const,
  issuesAll: (wsId: string) => [...overviewKeys.all(wsId), "issues"] as const,
  issues: (wsId: string, filter: RecentIssueFilter) =>
    [...overviewKeys.issuesAll(wsId), filter] as const,
};

/** Status tabs on the Dashboard's recent-issues list. */
export const RECENT_ISSUE_FILTERS = ["all", "in_progress", "blocked", "done", "cancelled"] as const;
export type RecentIssueFilter = (typeof RECENT_ISSUE_FILTERS)[number];

// Category filters keep custom statuses in their lifecycle tab. "Blocked" is a
// built-in key with no category of its own, so it filters by key.
const RECENT_ISSUE_FILTER_PARAMS: Record<RecentIssueFilter, ListIssuesParams> = {
  all: {},
  in_progress: { status_categories: ["started"] },
  blocked: { statuses: ["blocked"] },
  done: { status_categories: ["done"] },
  cancelled: { status_categories: ["closed"] },
};

export const RECENT_ISSUES_LIMIT = 50;

// Live updates arrive through activity:created (see use-realtime-sync), so the
// staleTime only bounds how old a remounted feed may be.
// The feed endpoint caps a page at 50; the Dashboard list scrolls inside it.
export const WORKSPACE_ACTIVITY_LIMIT = 50;

export function workspaceActivityOptions(wsId: string, kind: WorkspaceActivityKind = "all") {
  return queryOptions({
    queryKey: overviewKeys.activity(wsId, kind),
    queryFn: () => api.listWorkspaceActivity({ limit: WORKSPACE_ACTIVITY_LIMIT, kind }),
    select: (data) => data.entries,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

// Issue WS events refresh this through use-realtime-sync; the staleTime only
// bounds how old a remounted list may be.
export function recentIssuesOptions(wsId: string, filter: RecentIssueFilter) {
  return queryOptions({
    queryKey: overviewKeys.issues(wsId, filter),
    queryFn: () =>
      api.listIssues({
        ...RECENT_ISSUE_FILTER_PARAMS[filter],
        sort_by: "updated_at",
        sort_direction: "desc",
        limit: RECENT_ISSUES_LIMIT,
      }),
    select: (data) => data.issues,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
