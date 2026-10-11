import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const overviewKeys = {
  all: (wsId: string) => ["overview", wsId] as const,
  activityAll: (wsId: string) => [...overviewKeys.all(wsId), "activity"] as const,
  activity: (wsId: string, limit: number) =>
    [...overviewKeys.activityAll(wsId), limit] as const,
};

// Live updates arrive through activity:created (see use-realtime-sync), so the
// staleTime only bounds how old a remounted feed may be.
export function workspaceActivityOptions(wsId: string, limit = 10) {
  return queryOptions({
    queryKey: overviewKeys.activity(wsId, limit),
    queryFn: () => api.listWorkspaceActivity({ limit }),
    select: (data) => data.entries,
    staleTime: 30 * 1000,
  });
}
