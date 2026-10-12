import { infiniteQueryOptions, keepPreviousData, type InfiniteData } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ListIssuesParams,
  ListIssuesResponse,
  RecentlyCompletedResponse,
  WorkspaceActivityKind,
  WorkspaceActivityResponse,
} from "../types";

export const overviewKeys = {
  all: (wsId: string) => ["overview", wsId] as const,
  activityAll: (wsId: string) => [...overviewKeys.all(wsId), "activity"] as const,
  activity: (wsId: string, kind: WorkspaceActivityKind) =>
    [...overviewKeys.activityAll(wsId), kind] as const,
  issuesAll: (wsId: string) => [...overviewKeys.all(wsId), "issues"] as const,
  issues: (wsId: string, filter: RecentIssueFilter, statuses: readonly string[] = []) =>
    [...overviewKeys.issuesAll(wsId), filter, ...statuses] as const,
};

/** Status tabs on the Dashboard's recent-issues list. */
export const RECENT_ISSUE_FILTERS = ["all", "in_progress", "blocked", "done", "cancelled"] as const;
export type RecentIssueFilter = (typeof RECENT_ISSUE_FILTERS)[number];

/**
 * One row of the recent-issues list, whichever query backs the tab. `at` is
 * when the issue was last updated, or, on Done / Cancelled, when it got
 * there; `actor` is the assignee, or whoever moved it there.
 */
export interface RecentIssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  at: string;
  actor: { type: string; id: string } | null;
}

export const RECENT_ISSUES_LIMIT = 50;
// The feed endpoint caps a page at 50; the Dashboard list scrolls inside it.
export const WORKSPACE_ACTIVITY_LIMIT = 50;

// Every list below is paged: the Dashboard loads the next page as the reader
// scrolls near the end. WS events invalidate the whole prefix, which refetches
// the pages already loaded.

// Pages can overlap when rows move between fetches (an issue re-sorting on
// update); the first copy of a row wins.
function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

export function workspaceActivityOptions(wsId: string, kind: WorkspaceActivityKind = "all") {
  return infiniteQueryOptions({
    queryKey: overviewKeys.activity(wsId, kind),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.listWorkspaceActivity({ limit: WORKSPACE_ACTIVITY_LIMIT, kind, before: pageParam ?? undefined }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    select: (data: InfiniteData<WorkspaceActivityResponse, string | null>) =>
      uniqueById(data.pages.flatMap((page) => page.entries)),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Recently touched issues for the All / In progress / Blocked tabs, newest
 * update first. In progress takes its status keys from the caller (the
 * workspace catalog's started statuses minus Blocked), so custom started
 * statuses count while Blocked keeps its own tab.
 */
export function recentIssuesOptions(
  wsId: string,
  filter: "all" | "in_progress" | "blocked",
  inProgressStatuses: readonly string[] = [],
) {
  const params: ListIssuesParams =
    filter === "blocked"
      ? { statuses: ["blocked"] }
      : filter === "in_progress"
        ? { statuses: [...inProgressStatuses] }
        : {};
  return infiniteQueryOptions({
    queryKey: overviewKeys.issues(wsId, filter, filter === "in_progress" ? inProgressStatuses : []),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listIssues({
        ...params,
        sort_by: "updated_at",
        sort_direction: "desc",
        limit: RECENT_ISSUES_LIMIT,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.issues.length, 0);
      return last.issues.length > 0 && loaded < last.total ? loaded : undefined;
    },
    select: (data: InfiniteData<ListIssuesResponse, number>): RecentIssueRow[] =>
      uniqueById(
        data.pages.flatMap((page) =>
          page.issues.map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            at: issue.updated_at,
            actor:
              issue.assignee_type && issue.assignee_id
                ? { type: issue.assignee_type, id: issue.assignee_id }
                : null,
          })),
        ),
      ),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

/** Done / Cancelled tabs: newest first by when each issue got there. */
export function recentlyCompletedOptions(wsId: string, filter: "done" | "cancelled") {
  return infiniteQueryOptions({
    queryKey: overviewKeys.issues(wsId, filter),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listRecentlyCompleted({
        category: filter === "done" ? "done" : "closed",
        limit: RECENT_ISSUES_LIMIT,
        offset: pageParam,
      }),
    getNextPageParam: (last) => last.next_offset ?? undefined,
    select: (data: InfiniteData<RecentlyCompletedResponse, number>): RecentIssueRow[] =>
      uniqueById(
        data.pages.flatMap((page) =>
          page.entries.map((entry) => ({
            id: entry.issue.id,
            identifier: entry.issue.identifier,
            title: entry.issue.title,
            status: entry.issue.status,
            at: entry.completed_at,
            actor: entry.actor_type && entry.actor_id ? { type: entry.actor_type, id: entry.actor_id } : null,
          })),
        ),
      ),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}
