import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ReplaceAgentFallbacksRequest } from "../types";

export const agentFallbackKeys = {
  list: (wsId: string, agentId: string) =>
    ["workspaces", wsId, "agent-fallbacks", agentId] as const,
};

export function agentFallbacksOptions(wsId: string, agentId: string) {
  return queryOptions({
    queryKey: agentFallbackKeys.list(wsId, agentId),
    queryFn: () => api.listAgentFallbacks(agentId),
  });
}

// The server returns the saved list, but a malformed response parses to [];
// re-read instead of writing that into the cache.
export function useReplaceAgentFallbacks(wsId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ReplaceAgentFallbacksRequest) => api.replaceAgentFallbacks(agentId, data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: agentFallbackKeys.list(wsId, agentId) }),
  });
}
