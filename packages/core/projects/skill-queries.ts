import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { projectKeys } from "./queries";
import type { SetProjectAttachmentAudienceRequest } from "../types";

export const projectSkillKeys = {
  all: (wsId: string) => [...projectKeys.all(wsId), "skills"] as const,
  list: (wsId: string, projectId: string) =>
    [...projectSkillKeys.all(wsId), projectId] as const,
};

export function projectSkillsOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: projectSkillKeys.list(wsId, projectId),
    queryFn: () => api.listProjectSkills(projectId),
  });
}

export function useAddProjectSkills(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillIds: string[]) => api.addProjectSkills(projectId, skillIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectSkillKeys.list(wsId, projectId) });
    },
  });
}

export function useSetProjectSkillAudience(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, audience }: { skillId: string; audience: SetProjectAttachmentAudienceRequest }) =>
      api.setProjectSkillAudience(projectId, skillId, audience),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectSkillKeys.list(wsId, projectId) });
    },
  });
}

export function useRemoveProjectSkill(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Removal is idempotent: a skill another tab or member already detached
    // is the outcome the caller asked for, not an error.
    mutationFn: (skillId: string) =>
      api.removeProjectSkill(projectId, skillId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectSkillKeys.list(wsId, projectId) });
    },
  });
}
