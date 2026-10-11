import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { workspaceKeys } from "../workspace/queries";
import { projectKeys } from "./queries";
import type { SetProjectAttachmentAudienceRequest } from "../types";

export const projectMcpServerKeys = {
  all: (wsId: string) => [...projectKeys.all(wsId), "mcp-servers"] as const,
  list: (wsId: string, projectId: string) =>
    [...projectMcpServerKeys.all(wsId), projectId] as const,
};

export function projectMcpServersOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: projectMcpServerKeys.list(wsId, projectId),
    queryFn: () => api.listProjectMcpServers(projectId),
  });
}

export function useAddProjectMcpServers(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverIds: string[]) => api.addProjectMcpServers(projectId, serverIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectMcpServerKeys.list(wsId, projectId) });
      // The library list reports each entry's project_count.
      qc.invalidateQueries({ queryKey: workspaceKeys.mcpServers(wsId) });
    },
  });
}

export function useSetProjectMcpServerAudience(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, audience }: { serverId: string; audience: SetProjectAttachmentAudienceRequest }) =>
      api.setProjectMcpServerAudience(projectId, serverId, audience),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectMcpServerKeys.list(wsId, projectId) });
    },
  });
}

export function useRemoveProjectMcpServer(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Removal is idempotent: a server another tab or member already detached
    // is the outcome the caller asked for, not an error.
    mutationFn: (serverId: string) =>
      api.removeProjectMcpServer(projectId, serverId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectMcpServerKeys.list(wsId, projectId) });
      // The library list reports each entry's project_count.
      qc.invalidateQueries({ queryKey: workspaceKeys.mcpServers(wsId) });
    },
  });
}
