"use client";

import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { dispatchReasonCode } from "@multica/core/api";
import { useRunIssueAssignee } from "@multica/core/issues/mutations";
import type { Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { useT } from "../../i18n";

// Runs the issue's assigned agent (or squad leader) now. The run resumes the
// agent's latest session on the issue, unlike a per-run retry.
export function RunAssigneeButton({
  issueId,
  assigneeType,
  assigneeId,
}: {
  issueId: string;
  assigneeType: Issue["assignee_type"];
  assigneeId: Issue["assignee_id"];
}) {
  const { t } = useT("issues");
  const run = useRunIssueAssignee(issueId);

  if (!assigneeId || (assigneeType !== "agent" && assigneeType !== "squad")) return null;

  const handleRun = () =>
    run.mutate(undefined, {
      onError: (e) => {
        const code = dispatchReasonCode(e);
        // The server keeps a waiting run rather than replacing it; it will wake
        // the agent, so this is information, not a failure.
        if (code === "already_active") {
          toast.info(t(($) => $.detail.run_assignee_queued));
          return;
        }
        toast.error(
          code === "invocation_not_allowed"
            ? t(($) => $.detail.run_assignee_blocked)
            : code === "issue_in_triage"
              ? t(($) => $.detail.run_assignee_triage)
              : e instanceof Error && e.message
                ? e.message
                : t(($) => $.detail.run_assignee_failed),
        );
      },
    });

  const label = t(($) => $.detail.run_assignee);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0 text-muted-foreground"
            aria-label={label}
            aria-busy={run.isPending}
            disabled={run.isPending}
            onClick={handleRun}
          >
            {run.isPending ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
