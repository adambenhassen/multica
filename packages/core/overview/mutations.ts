import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { overviewKeys } from "./queries";

/**
 * Pins an issue to the top of the Activity feed, or unpins it. The pin list
 * changes at once and rolls back if the server refuses.
 */
export function useSetActivityPin(wsId: string) {
  const qc = useQueryClient();
  const key = overviewKeys.pins(wsId);
  return useMutation({
    mutationFn: ({ issueId, pinned }: { issueId: string; pinned: boolean }) =>
      pinned ? api.pinActivityIssue(issueId) : api.unpinActivityIssue(issueId),
    onMutate: async ({ issueId, pinned }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<string[]>(key);
      qc.setQueryData<string[]>(key, (old = []) =>
        pinned ? (old.includes(issueId) ? old : [...old, issueId]) : old.filter((id) => id !== issueId),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
