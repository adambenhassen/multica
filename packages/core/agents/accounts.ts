import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CreateAgentAccountRequest, UpdateAgentAccountRequest } from "../types";

export const agentAccountKeys = {
  list: (wsId: string) => ["workspaces", wsId, "agent-accounts"] as const,
};

export function agentAccountListOptions(wsId: string) {
  return queryOptions({
    queryKey: agentAccountKeys.list(wsId),
    queryFn: () => api.listAgentAccounts(),
    enabled: Boolean(wsId),
  });
}

// Writes await the server and re-read the list rather than patching it: the
// response is redacted, and a malformed one parses to an empty account.
export function useCreateAgentAccount(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAgentAccountRequest) => api.createAgentAccount(data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: agentAccountKeys.list(wsId) }),
  });
}

export function useUpdateAgentAccount(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateAgentAccountRequest) =>
      api.updateAgentAccount(id, data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: agentAccountKeys.list(wsId) }),
  });
}

export function useDeleteAgentAccount(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgentAccount(id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: agentAccountKeys.list(wsId) }),
  });
}
