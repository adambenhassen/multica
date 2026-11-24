"use client";

import { useMemo, useState } from "react";
import { Activity, Bell, CircleDashed, GitMerge, Hourglass, SlidersHorizontal, TriangleAlert, X } from "@multica/ui/icons";
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
import { WorkspaceAgentWorkingChip, chipAppearance, countRuns } from "../../issues/components/workspace-agent-working-chip";
import { useT } from "../../i18n";
import { StatusChangesFeed, useRunningTasks, useWaitingIssues, type FeedFocus, type FeedTab, type FeedTabCounts } from "./activity-feed";
import { WAITING_CHIPS, waitingChip, type WaitingChip } from "../utils";
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
  // The waiting chip that opened the Waiting tab, shown pressed while it stays open.
  const [openedBy, setOpenedBy] = useState<WaitingChip | null>(null);
  const changeTab = (next: FeedTab, chip: WaitingChip | null = null) => {
    setTab(next);
    setOpenedBy(chip);
  };
  const workingAgents = useWorkingAgents(wsId, projectId);
  const waiting = useWaitingCounts(wsId, projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.title)}
        actions={
          <>
            {/* A phone's header has no room for the chips: there the Active
                and Waiting tabs carry the counts. */}
            <div className="hidden md:contents">
              {/* How many agents are running right now; opens the Active tab. */}
              <WorkspaceAgentWorkingChip
                value={tab === "active"}
                onToggle={() => changeTab(tab === "active" ? "all" : "active")}
                agents={workingAgents}
              />
              {/* How many issues wait on each kind of thing; each opens the Waiting tab. */}
              {waiting &&
                WAITING_CHIPS.filter((chip) => waiting.chips[chip]).map((chip) => {
                  const pressed = tab === "waiting" && openedBy === chip;
                  return (
                    <WaitingChipButton
                      key={chip}
                      chip={chip}
                      count={waiting.chips[chip]!}
                      value={pressed}
                      onToggle={() => (pressed ? changeTab("all") : changeTab("waiting", chip))}
                    />
                  );
                })}
            </div>
            <ProjectFilter projects={projects} projectValue={projectValue} onProjectChange={setProjectValue} />
            <DisplayMenu />
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("flex min-h-full flex-col pt-3 md:py-6", PAGE_GUTTER)}>
          <ActivityList
            // A new project starts from a clean slate: an issue filter from
            // another project would leave the feed empty.
            key={projectId ?? ALL_PROJECTS}
            projectId={projectId}
            tab={tab}
            onTabChange={changeTab}
            tabCounts={{ active: workingAgents && countRuns(workingAgents), waiting: waiting?.total }}
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
  tabCounts,
}: {
  projectId: string | null;
  tab: FeedTab;
  onTabChange: (tab: FeedTab) => void;
  tabCounts: FeedTabCounts;
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
    // Fills the page height (at least 30rem, 20rem on a phone), so the list
    // reaches the bottom of the window and scrolls inside.
    <div className="flex min-h-[20rem] flex-1 basis-0 flex-col gap-3 md:min-h-[30rem]">
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
      <div className="flex min-h-0 flex-1 flex-col">
        <StatusChangesFeed focus={focus} tab={tab} onTabChange={onTabChange} tabCounts={tabCounts} />
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
 * How many issues wait, in all and per header chip, narrowed to the header's
 * project like the working chip. `undefined` until known.
 */
function useWaitingCounts(
  wsId: string,
  projectId: string | null,
): { total: number; chips: Partial<Record<WaitingChip, number>> } | undefined {
  const waiting = useWaitingIssues(wsId);
  const ids = useMemo(() => [...waiting.byIssue.keys()].sort(), [waiting.byIssue]);
  const { data: projectIssues } = useQuery({
    ...activeIssuesOptions(wsId, ids, projectId),
    enabled: !waiting.pending && projectId !== null,
  });
  return useMemo(() => {
    if (waiting.pending) return undefined;
    let inProject: Set<string> | null = null;
    if (projectId !== null) {
      if (!projectIssues) return undefined;
      inProject = new Set(projectIssues.map((i) => i.id));
    }
    let total = 0;
    const chips: Partial<Record<WaitingChip, number>> = {};
    for (const [id, reason] of waiting.byIssue) {
      if (inProject && !inProject.has(id)) continue;
      total += 1;
      const chip = waitingChip(reason);
      if (chip) chips[chip] = (chips[chip] ?? 0) + 1;
    }
    return { total, chips };
  }, [waiting, projectId, projectIssues]);
}

const WAITING_CHIP_ICON = {
  ci_running: CircleDashed,
  ci_waiting: Hourglass,
  blocked: TriangleAlert,
  gate: GitMerge,
  scheduled: Bell,
} satisfies Record<WaitingChip, unknown>;

function WaitingChipButton({
  chip,
  count,
  value,
  onToggle,
}: {
  chip: WaitingChip;
  count: number;
  value: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("overview");
  const appearance = chipAppearance(value, "some");
  const label = t(($) => $.waiting.chips[chip], { count });
  const Icon = WAITING_CHIP_ICON[chip];
  return (
    <Button
      variant={appearance.variant}
      size="sm"
      className={appearance.className}
      onClick={onToggle}
      aria-pressed={value}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" />
      {/* Five labelled chips outgrow a narrower header: there each shows its count. */}
      <span className="tabular-nums min-[1400px]:hidden">{count}</span>
      <span className="hidden tabular-nums min-[1400px]:inline">{label}</span>
    </Button>
  );
}
