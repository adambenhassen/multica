import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { projectKeys } from "./queries";

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

export function useRemoveProjectSkill(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => api.removeProjectSkill(projectId, skillId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectSkillKeys.list(wsId, projectId) });
    },
  });
}
