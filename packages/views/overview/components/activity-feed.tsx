"use client";

import { memo, useMemo, type ReactNode } from "react";
import { Activity, ArrowRight, ListFilter, CirclePlus, CircleX, MessageSquare, Pencil, UserRound } from "lucide-react";
import { useInfiniteQuery, useQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { useOverviewLayoutStore, workspaceActivityOptions } from "@multica/core/overview";
import type {
  WorkspaceActivityEntry,
  WorkspaceActivityIssueRef,
  WorkspaceActivityKind,
} from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { StatusIcon } from "../../issues/components/status-icon";
import { PriorityIcon } from "../../issues/components/priority-icon";
import { ProjectIcon } from "../../projects/components/project-icon";
import { formatActivity } from "../../issues/utils/format-activity";
import { Segmented } from "../../dashboard/components/dashboard-shared";
import { InfiniteScrollSentinel } from "../../issues/components/infinite-scroll-sentinel";
import { addDaysIso, todayIso } from "../../runtimes/utils";
import { useLocale, useT, useTimeAgo } from "../../i18n";
import {
  STATUS_CHANGE_FILTERS,
  coalesceFeed,
  commentExcerpt,
  groupFeedByDay,
  latestStatusChangePerIssue,
  statusChangeTargets,
} from "../utils";
import { EmptyBox, ErrorBox, LIST_CLASS, LIST_SECTION_CLASS, ListSkeleton, SectionHeading } from "./section-parts";

/**
 * What the feed points at, owned by the page: the hovered issue's rows are
 * tinted, `issue` narrows the feed to one issue's history, and `projectId` to
 * one project's issues.
 */
export interface FeedFocus {
  hoveredIssueId: string | null;
  onHoverIssue: (issueId: string | null) => void;
  issue: WorkspaceActivityIssueRef | null;
  onFilterIssue: (issue: WorkspaceActivityIssueRef) => void;
  projectId: string | null;
}

/**
 * The feed's tabs: everything, the issues agents are working on now, the
 * status a change went into, or failed agent runs.
 */
const FEED_TABS = ["all", "active", ...STATUS_CHANGE_FILTERS.filter((f) => f !== "all"), "failures"] as const;
export type FeedTab = (typeof FEED_TABS)[number];

/**
 * Running tasks from the live task snapshot, grouped by issue (the agents on
 * it and when the earliest run started) and by agent (how many runs).
 * `pending` until the snapshot has loaded.
 */
export function useRunningTasks(wsId: string) {
  const { data: snapshot, isPending } = useQuery(agentTaskSnapshotOptions(wsId));
  return useMemo(() => {
    const byIssue = new Map<string, { agentIds: string[]; since: string }>();
    const byAgent = new Map<string, { count: number; issueIds: string[] }>();
    for (const task of snapshot ?? []) {
      if (task.status !== "running") continue;
      const agent = byAgent.get(task.agent_id) ?? { count: 0, issueIds: [] };
      agent.count += 1;
      if (task.issue_id) agent.issueIds.push(task.issue_id);
      byAgent.set(task.agent_id, agent);
      if (!task.issue_id) continue;
      const started = task.started_at ?? task.created_at;
      const cur = byIssue.get(task.issue_id) ?? { agentIds: [], since: started };
      if (!cur.agentIds.includes(task.agent_id)) cur.agentIds.push(task.agent_id);
      if (started < cur.since) cur.since = started;
      byIssue.set(task.issue_id, cur);
    }
    return { pending: isPending, byIssue, byAgent };
  }, [snapshot, isPending]);
}

/**
 * Every status change across the workspace, newest first, each shown as the
 * move itself, with issue creations. The tabs narrow it by the status a change
 * went into, or switch to the issues agents are working on now or to failed
 * agent runs. The display choices mix comments and other issue changes into
 * the All tab, and can keep only each issue's latest move.
 */
export function StatusChangesFeed({
  focus,
  tab,
  onTabChange,
}: {
  focus: FeedFocus;
  /** Owned by the page, so its header can open the Active tab. */
  tab: FeedTab;
  onTabChange: (tab: FeedTab) => void;
}) {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const showComments = useOverviewLayoutStore((s) => s.showComments);
  const showOther = useOverviewLayoutStore((s) => s.showOther);
  // Custom statuses come from the catalog, so a category tab waits for it.
  const targets = useMemo(
    () => (tab === "failures" || tab === "active" ? [] : statusChangeTargets(tab, catalog)),
    [tab, catalog],
  );
  // Active is the All feed for the issues agents are working on right now.
  const running = useRunningTasks(wsId);
  const activeIssues = useMemo(() => {
    const ids = [...running.byIssue.keys()].sort();
    return focus.issue ? ids.filter((id) => id === focus.issue!.id) : ids;
  }, [running.byIssue, focus.issue]);
  const allLike = tab === "all" || tab === "active";
  // Comments and other changes are not moves into a status, so only the All
  // (and Active) tab mixes them in.
  const kind: WorkspaceActivityKind =
    tab === "failures"
      ? "failures"
      : !allLike
        ? "status"
        : showComments && showOther
          ? "all"
          : showComments
            ? "status_comments"
            : showOther
              ? "changes"
              : "status";
  const query = useInfiniteQuery({
    ...workspaceActivityOptions(wsId, {
      kind,
      to: targets ?? [],
      issues: tab === "active" ? activeIssues : focus.issue ? [focus.issue.id] : [],
      project: focus.projectId,
    }),
    // With nobody working, Active has no issues to ask for: an empty filter
    // would mean every issue.
    enabled: targets !== null && (tab !== "active" || (!running.pending && activeIssues.length > 0)),
  });
  const tabLabels: Record<FeedTab, string> = {
    all: t(($) => $.status_changes.filters.all),
    active: t(($) => $.status_changes.filters.active),
    in_progress: t(($) => $.status_changes.filters.in_progress),
    blocked: t(($) => $.status_changes.filters.blocked),
    done: t(($) => $.status_changes.filters.done),
    cancelled: t(($) => $.status_changes.filters.cancelled),
    failures: t(($) => $.status_changes.filters.failures),
  };

  return (
    <section className={LIST_SECTION_CLASS}>
      <SectionHeading
        action={
          // The tabs outgrow a phone: they scroll sideways rather than wrap.
          <div className="max-w-full overflow-x-auto">
            <Segmented
              label={t(($) => $.status_changes.filter_label)}
              value={tab}
              onChange={onTabChange}
              options={FEED_TABS.map((value) => ({ value, label: tabLabels[value] }))}
            />
          </div>
        }
      >
        {t(($) => $.activity.heading)}
      </SectionHeading>
      {tab === "active" && !running.pending && activeIssues.length === 0 ? (
        <EmptyBox>{t(($) => $.status_changes.empty_active)}</EmptyBox>
      ) : (
        <FeedBody
          query={query}
          focus={focus}
          empty={
            allLike
              ? t(($) => $.status_changes.empty)
              : tab === "failures"
                ? t(($) => $.status_changes.empty_failures)
                : t(($) => $.status_changes.empty_filtered)
          }
        />
      )}
    </section>
  );
}

/** A paged feed grouped under day headings, with its loading, error and empty states. */
function FeedBody({
  query,
  focus,
  empty,
}: {
  query: UseInfiniteQueryResult<WorkspaceActivityEntry[]>;
  focus: FeedFocus;
  empty: string;
}) {
  const { t } = useT("overview");
  const locale = useLocale();
  const tz = useViewingTimezone();
  const wsId = useWorkspaceId();
  // Project labels resolve through the project list the app already caches.
  const { data: projectList } = useQuery(projectListOptions(wsId));
  const projects = useMemo(() => new Map((projectList ?? []).map((p) => [p.id, p] as const)), [projectList]);
  // Agents working on each issue right now, from the live task snapshot the
  // app already keeps fresh over WebSocket.
  const { byIssue: working } = useRunningTasks(wsId);
  const { data: entries, isPending, isError, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const latestOnly = useOverviewLayoutStore((s) => s.latestOnly);
  const groups = useMemo(() => {
    const rows = latestOnly ? latestStatusChangePerIssue(entries ?? []) : (entries ?? []);
    return groupFeedByDay(coalesceFeed(rows), tz);
  }, [entries, tz, latestOnly]);

  const today = todayIso(tz);
  const dayLabel = (day: string) => {
    if (day === today) return t(($) => $.activity.today);
    if (day === addDaysIso(today, -1)) return t(($) => $.activity.yesterday);
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00Z`));
  };

  if (isPending) return <ListSkeleton />;
  if (isError) return <ErrorBox onRetry={() => void refetch()} />;
  if (groups.length === 0) return <EmptyBox>{empty}</EmptyBox>;
  return (
    <div className={cn(LIST_CLASS, "@container")}>
      {groups.map((group) => (
        <div key={group.day}>
          <div className="sticky top-0 z-10 border-b bg-card px-4 py-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
            {dayLabel(group.day)}
          </div>
          <div className="divide-y">
            {group.entries.map((entry) => (
              <FeedRow
                key={entry.id}
                entry={entry}
                project={entry.issue.project_id ? projects.get(entry.issue.project_id) : undefined}
                workingAgentIds={working.get(entry.issue.id)?.agentIds}
                // Filtered to one issue, every row is that issue: no tint, no filter button.
                highlighted={!focus.issue && focus.hoveredIssueId === entry.issue.id}
                onHoverIssue={focus.onHoverIssue}
                onFilterIssue={focus.issue ? undefined : focus.onFilterIssue}
              />
            ))}
          </div>
        </div>
      ))}
      {hasNextPage && (
        <InfiniteScrollSentinel
          onVisible={() => {
            if (!isFetchingNextPage) void fetchNextPage();
          }}
          loading={isFetchingNextPage}
        />
      )}
    </div>
  );
}

/** The project a row's label names. */
type RowProject = { id: string; title: string; icon: string | null };

/**
 * One event on one line: what happened as an icon, the issue, the agents
 * working on it now, its project,
 * the move as status icons, the actor's avatar, then when. A wide list also
 * names the statuses and the actor and puts any other event into words; otherwise
 * every icon names itself on hover, and the names hidden from view stay for
 * screen readers. Sized by the list's width (it is
 * the query container): a narrow list drops the project, then the detail, so
 * the title stays readable.
 */
const FeedRow = memo(function FeedRow({
  entry,
  project,
  workingAgentIds,
  highlighted,
  onHoverIssue,
  onFilterIssue,
}: {
  entry: WorkspaceActivityEntry;
  /** The issue's project; its column stays (empty) without one. */
  project: RowProject | undefined;
  /** Agents with a task running on the issue right now. */
  workingAgentIds: string[] | undefined;
  /** Another row of the same issue is hovered. */
  highlighted: boolean;
  onHoverIssue: (issueId: string | null) => void;
  /** Absent while the feeds are already filtered to one issue. */
  onFilterIssue?: (issue: WorkspaceActivityIssueRef) => void;
}) {
  const { t } = useT("overview");
  const { t: tIssues } = useT("issues");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const catalog = useIssueStatuses(wsId);
  const { getActorName } = useActorName();

  const details = (entry.details ?? {}) as Record<string, string>;
  const isComment = entry.type === "comment";
  const isMove = entry.action === "status_changed" && !!details.to;
  const isCreated = entry.type === "activity" && entry.action === "created";
  const actorName = entry.actor_name || getActorName(entry.actor_type, entry.actor_id);
  const excerpt = isComment ? commentExcerpt(entry.content ?? "") : "";

  let phrase: string;
  let lead: ReactNode;
  if (isComment) {
    phrase = entry.parent_id ? t(($) => $.activity.replied) : t(($) => $.activity.commented);
    lead = <MessageSquare className="size-4 text-muted-foreground" />;
  } else if (isMove) {
    const status = catalog.labelOf(details.to!);
    const category = catalog.categoryOf(details.to!);
    phrase =
      category === "done" || category === "closed"
        ? t(($) => $.activity.marked, { status })
        : t(($) => $.activity.moved, { status });
    lead = (
      <StatusIcon
        status={details.to!}
        category={category}
        color={catalog.colorOf(details.to!)}
        icon={catalog.iconOf(details.to!)}
        className="size-4"
      />
    );
  } else if (entry.action === "task_failed") {
    phrase = t(($) => $.activity.run_failed);
    lead = <CircleX className="size-4 text-destructive" />;
  } else if (isCreated) {
    phrase = t(($) => $.activity.issue_created);
    lead = <CirclePlus className="size-4 text-muted-foreground" />;
  } else {
    phrase = formatActivity(entry, tIssues, locale, getActorName, catalog.labelOf);
    lead =
      entry.action === "assignee_changed" ? (
        <UserRound className="size-4 text-muted-foreground" />
      ) : entry.action === "priority_changed" && details.to ? (
        <PriorityIcon priority={details.to} className="size-4" />
      ) : entry.action === "title_changed" || entry.action === "description_updated" ? (
        <Pencil className="size-4 text-muted-foreground" />
      ) : (
        <Activity className="size-4 text-muted-foreground" />
      );
  }
  // A comment's line of text lives in its icon's tooltip.
  const action = excerpt ? t(($) => $.activity.with_excerpt, { phrase, excerpt }) : phrase;
  const href = paths.issueDetail(entry.issue.id) + (isComment ? `#comment-${entry.id}` : "");

  // Hovering (or focusing) a row tints every row of its issue in both feeds,
  // so its history reads at a glance; clicking still opens the issue.
  return (
    <div
      className={cn(
        "group relative transition-colors hover:bg-accent/50",
        highlighted && "bg-brand/10 hover:bg-brand/15",
      )}
      onMouseEnter={() => onHoverIssue(entry.issue.id)}
      onMouseLeave={() => onHoverIssue(null)}
      onFocus={() => onHoverIssue(entry.issue.id)}
      onBlur={() => onHoverIssue(null)}
    >
      <AppLink href={href} className="flex min-w-0 items-center gap-3 px-4 py-2">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center" title={action}>
          {lead}
        </span>
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{entry.issue.identifier}</span>
        <span className="min-w-32 flex-1 truncate text-label" title={entry.issue.title}>
          {entry.issue.title}
        </span>
        {/* Fixed-width columns keep working agents and project labels aligned down the list. */}
        <WorkingAgents agentIds={workingAgentIds} />
        <span
          className="hidden w-32 shrink-0 items-center gap-1 text-caption text-muted-foreground @lg:flex"
          title={project?.title}
        >
          {project && (
            <>
              <ProjectIcon project={project} size="sm" />
              <span className="truncate">{project.title}</span>
            </>
          )}
        </span>
        {/* The move and the actor each get a fixed column: icons only, or with
            their names once the list is wide (56rem) enough to spare them. */}
        <span className="hidden shrink-0 items-center gap-2 text-caption text-muted-foreground @sm:flex">
          <span className="flex w-14 items-center justify-end gap-1.5 @4xl:w-56 @4xl:justify-start">
            {/* What happened, in words, once the list has room: a comment's
                text, or the change ("assigned to Builder"). Screen readers get
                the full sentence from the sr-only copy below. */}
            {isCreated ? (
              // A new issue reads like a move: its icon, then (wide) its name.
              <span aria-hidden="true" className="flex min-w-0 shrink-0 items-center gap-1 @4xl:shrink" title={phrase}>
                <CirclePlus className="size-3.5 shrink-0" />
                <span className="hidden truncate text-foreground @4xl:inline">{phrase}</span>
              </span>
            ) : (
              !isMove && (
                <span aria-hidden="true" className="hidden min-w-0 truncate @4xl:inline">
                  {excerpt || phrase}
                </span>
              )
            )}
            {isMove && (
              <>
                {details.from && (
                  <>
                    <StatusChip statusKey={details.from} />
                    <ArrowRight aria-label="→" className="size-3 shrink-0" />
                  </>
                )}
                <StatusChip statusKey={details.to!} />
              </>
            )}
            {/* Repeats of the same event fold into one row; the count stays
                inside this fixed column so the row keeps its alignment. */}
            {(entry.coalesced_count ?? 1) > 1 && (
              <span className="shrink-0 tabular-nums">×{entry.coalesced_count}</span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 @4xl:w-36">
            <ActorAvatar
              actorType={entry.actor_type}
              actorId={entry.actor_id}
              name={entry.actor_name}
              avatarUrl={entry.actor_avatar_url}
              size="xs"
              profileLink={false}
              enableHoverCard
            />
            <span className="sr-only @4xl:hidden">{actorName}</span>
            <span className="hidden truncate font-medium text-foreground @4xl:inline">{actorName}</span>
          </span>
          {!isMove && <span className="sr-only">{action}</span>}
        </span>
        <span
          className={cn(
            "w-16 shrink-0 text-right text-caption text-muted-foreground",
            // The filter button takes the time's place while the row is hovered.
            onFilterIssue && "group-hover:invisible group-focus-within:invisible",
          )}
        >
          {timeAgo(entry.created_at)}
        </span>
      </AppLink>
      {onFilterIssue && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(($) => $.issue_filter.filter)}
          title={t(($) => $.issue_filter.filter)}
          // Centered without a transform: Button's pressed state sets its own
          // translate, which would drop the button out from under the pointer.
          className="absolute inset-y-0 right-3 my-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onFilterIssue(entry.issue)}
        >
          <ListFilter aria-hidden="true" />
        </Button>
      )}
    </div>
  );
});

/** Up to three overlapping avatars of the agents working on the issue now. */
function WorkingAgents({ agentIds }: { agentIds: string[] | undefined }) {
  const { t } = useT("overview");
  const { getActorName } = useActorName();
  const names = (agentIds ?? []).map((id) => getActorName("agent", id)).join(", ");
  const shown = (agentIds ?? []).slice(0, 3);
  const extra = (agentIds?.length ?? 0) - shown.length;
  return (
    <span
      className="hidden w-14 shrink-0 items-center justify-end @lg:flex"
      title={names ? t(($) => $.working_now, { names }) : undefined}
    >
      {shown.length > 0 && (
        <>
          <span className="sr-only">{t(($) => $.working_now, { names })}</span>
          <span aria-hidden="true" className="flex items-center -space-x-1">
            {shown.map((id) => (
              <ActorAvatar key={id} actorType="agent" actorId={id} size="xs" profileLink={false} showStatusDot />
            ))}
          </span>
          {extra > 0 && <span className="pl-1 text-micro text-muted-foreground tabular-nums">+{extra}</span>}
        </>
      )}
    </span>
  );
}

/**
 * A status as its icon, named beside it once the list is wide (56rem);
 * narrower, the name is the hover tooltip and the screen-reader text.
 */
function StatusChip({ statusKey }: { statusKey: string }) {
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const label = catalog.labelOf(statusKey);
  return (
    <span className="flex shrink-0 items-center gap-1 @4xl:min-w-0 @4xl:shrink" title={label}>
      <StatusIcon
        status={statusKey}
        category={catalog.categoryOf(statusKey)}
        color={catalog.colorOf(statusKey)}
        icon={catalog.iconOf(statusKey)}
        className="size-3.5 shrink-0"
      />
      <span className="sr-only @4xl:hidden">{label}</span>
      <span className="hidden truncate text-foreground @4xl:inline">{label}</span>
    </span>
  );
}
