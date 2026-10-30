"use client";

import { useMemo, useState } from "react";
import { Activity, Hourglass, SlidersHorizontal, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { activeIssuesOptions, useOverviewLayoutStore } from "@multica/core/overview";
import type { WorkingAgentSummary, WorkspaceActivityIssueRef } from "@multica/core/types";
import { CollectionPageHeader, CollectionPageHeaderAction } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { ALL_PROJECTS } from "../../dashboard/components/dashboard-shared";
import { ProjectFilter } from "../../dashboard/components/dashboard-filters";
import { WorkspaceAgentWorkingChip, chipAppearance } from "../../issues/components/workspace-agent-working-chip";
import { useT } from "../../i18n";
import { StatusChangesFeed, useRunningTasks, useWaitingIssues, type FeedFocus, type FeedTab } from "./activity-feed";
import { cn } from "@multica/ui/lib/utils";

export function OverviewPage() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const [projectValue, setProjectValue] = useState<string>(ALL_PROJECTS);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  // A project that no longer resolves (deleted, or a stale id) counts as no
  // filter, so the trigger cannot claim a filter the feed does not apply.
  const projectId =
    projectValue !== ALL_PROJECTS && projects.some((p) => p.id === projectValue) ? projectValue : null;
  const [tab, setTab] = useState<FeedTab>("all");
  const workingAgents = useWorkingAgents(wsId, projectId);
  const waitingCount = useWaitingCount(wsId, projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.title)}
        actions={
          <>
            {/* How many agents are running right now; opens the Active tab. */}
            <WorkspaceAgentWorkingChip
              value={tab === "active"}
              onToggle={() => setTab(tab === "active" ? "all" : "active")}
              agents={workingAgents}
            />
            {/* How many issues wait on a queued run or CI; opens the Waiting tab. */}
            <WaitingChip
              value={tab === "waiting"}
              onToggle={() => setTab(tab === "waiting" ? "all" : "waiting")}
              count={waitingCount}
            />
            <ProjectFilter projects={projects} projectValue={projectValue} onProjectChange={setProjectValue} />
            <DisplayMenu />
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("flex min-h-full flex-col py-6", PAGE_GUTTER)}>
          <ActivityList
            // A new project starts from a clean slate: an issue filter from
            // another project would leave the feed empty.
            key={projectId ?? ALL_PROJECTS}
            projectId={projectId}
            tab={tab}
            onTabChange={setTab}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The status-change feed, narrowed to the header's project. Hovering a row
 * tints the issue's other rows, and an optional issue filter is cleared from
 * the chip above.
 */
function ActivityList({
  projectId,
  tab,
  onTabChange,
}: {
  projectId: string | null;
  tab: FeedTab;
  onTabChange: (tab: FeedTab) => void;
}) {
  const { t } = useT("overview");
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null);
  const [issue, setIssue] = useState<WorkspaceActivityIssueRef | null>(null);
  const focus: FeedFocus = {
    hoveredIssueId,
    onHoverIssue: setHoveredIssueId,
    issue,
    onFilterIssue: setIssue,
    projectId,
  };

  return (
    // Fills the page height (at least 30rem), so the list reaches the bottom
    // of the window and scrolls inside.
    <div className="flex flex-col gap-3 md:min-h-[30rem] md:flex-1 md:basis-0">
      {issue && (
        <div className="flex min-w-0 items-center gap-2 text-label">
          <span className="shrink-0 text-muted-foreground">{t(($) => $.issue_filter.label)}</span>
          <span className="flex min-w-0 items-center gap-1.5 rounded-md border bg-card py-0.5 pr-0.5 pl-2">
            <span className="shrink-0 font-mono text-caption text-muted-foreground">{issue.identifier}</span>
            <span className="min-w-0 truncate" title={issue.title}>
              {issue.title}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t(($) => $.issue_filter.clear)}
              title={t(($) => $.issue_filter.clear)}
              onClick={() => setIssue(null)}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        </div>
      )}
      <div className="flex flex-col md:min-h-0 md:flex-1">
        <StatusChangesFeed focus={focus} tab={tab} onTabChange={onTabChange} />
      </div>
    </div>
  );
}

/**
 * What the feed shows beyond status changes: comments and other issue changes
 * on the All tab, whether each issue keeps only its latest move, and what each
 * issue waits on in every tab. Remembered per device.
 */
function DisplayMenu() {
  const { t } = useT("overview");
  const showComments = useOverviewLayoutStore((s) => s.showComments);
  const showOther = useOverviewLayoutStore((s) => s.showOther);
  const latestOnly = useOverviewLayoutStore((s) => s.latestOnly);
  const showWaiting = useOverviewLayoutStore((s) => s.showWaiting);
  const toggleComments = useOverviewLayoutStore((s) => s.toggleComments);
  const toggleOther = useOverviewLayoutStore((s) => s.toggleOther);
  const toggleLatestOnly = useOverviewLayoutStore((s) => s.toggleLatestOnly);
  const toggleWaiting = useOverviewLayoutStore((s) => s.toggleWaiting);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<CollectionPageHeaderAction icon={SlidersHorizontal} label={t(($) => $.display.button)} />}
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.display.on_all)}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={showComments} onCheckedChange={toggleComments}>
            {t(($) => $.display.comments)}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showOther} onCheckedChange={toggleOther}>
            {t(($) => $.display.other)}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuCheckboxItem checked={latestOnly} onCheckedChange={toggleLatestOnly}>
            {t(($) => $.display.latest_only)}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showWaiting} onCheckedChange={toggleWaiting}>
            {t(($) => $.display.waiting)}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The agents running a task right now, for the header chip. With a project
 * picked, only runs on that project's issues count, so the chip never
 * advertises work the Active tab will not list. `undefined` until known.
 */
function useWorkingAgents(wsId: string, projectId: string | null): WorkingAgentSummary[] | undefined {
  const running = useRunningTasks(wsId);
  const ids = useMemo(() => [...running.byIssue.keys()].sort(), [running.byIssue]);
  const { data: projectIssues } = useQuery({
    ...activeIssuesOptions(wsId, ids, projectId),
    enabled: !running.pending && projectId !== null,
  });
  return useMemo(() => {
    if (running.pending) return undefined;
    let inProject: Set<string> | null = null;
    if (projectId !== null) {
      if (!projectIssues) return undefined;
      inProject = new Set(projectIssues.map((i) => i.id));
    }
    const out: WorkingAgentSummary[] = [];
    for (const [id, agent] of running.byAgent) {
      const count = inProject ? agent.issueIds.filter((issueId) => inProject.has(issueId)).length : agent.count;
      if (count > 0) out.push({ id, running_task_count: count });
    }
    return out.sort((a, b) => b.running_task_count - a.running_task_count);
  }, [running, projectId, projectIssues]);
}

/**
 * How many issues wait on a queued run or CI, narrowed to the header's
 * project like the working chip. `undefined` until known.
 */
function useWaitingCount(wsId: string, projectId: string | null): number | undefined {
  const waiting = useWaitingIssues(wsId);
  const ids = useMemo(() => [...waiting.byIssue.keys()].sort(), [waiting.byIssue]);
  const { data: projectIssues } = useQuery({
    ...activeIssuesOptions(wsId, ids, projectId),
    enabled: !waiting.pending && projectId !== null,
  });
  if (waiting.pending) return undefined;
  if (projectId === null) return ids.length;
  return projectIssues?.length;
}

function WaitingChip({ value, onToggle, count }: { value: boolean; onToggle: () => void; count: number | undefined }) {
  const { t } = useT("overview");
  const appearance = chipAppearance(value, count === undefined ? "unknown" : count > 0 ? "some" : "none");
  const label = count === undefined ? t(($) => $.waiting.chip_unknown) : t(($) => $.waiting.chip, { count });
  return (
    <Button
      variant={appearance.variant}
      size="sm"
      className={appearance.className}
      onClick={onToggle}
      aria-pressed={value}
      aria-label={label}
    >
      <Hourglass aria-hidden="true" />
      <span className="tabular-nums md:hidden">{count === undefined ? "—" : count}</span>
      <span className="hidden tabular-nums md:inline">{label}</span>
    </Button>
  );
}
