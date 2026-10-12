"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowRight, CirclePlus, CircleX, MessageSquare, Pencil, UserRound } from "lucide-react";
import { useInfiniteQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { workspaceActivityOptions } from "@multica/core/overview";
import type { WorkspaceActivityEntry, WorkspaceActivityKind } from "@multica/core/types";
import { AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { StatusIcon } from "../../issues/components/status-icon";
import { PriorityIcon } from "../../issues/components/priority-icon";
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
  statusChangeTargets,
  type StatusChangeFilter,
} from "../utils";
import { EmptyBox, ErrorBox, LIST_CLASS, LIST_SECTION_CLASS, ListSkeleton, SectionHeading } from "./section-parts";

// Status changes have their own section (StatusChangesFeed).
const FEED_KINDS = ["all", "comments", "failures"] as const satisfies readonly WorkspaceActivityKind[];
type FeedKind = (typeof FEED_KINDS)[number];

/**
 * What is happening across the workspace, issue first: each row names the
 * issue, then who did what to it in plain words. Run completions and other
 * machine bookkeeping are filtered out server-side.
 */
export function ActivityFeed() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const [kind, setKind] = useState<FeedKind>("all");
  const query = useInfiniteQuery(workspaceActivityOptions(wsId, kind));
  const kindLabels: Record<FeedKind, string> = {
    all: t(($) => $.activity.filters.all),
    comments: t(($) => $.activity.filters.comments),
    failures: t(($) => $.activity.filters.failures),
  };

  return (
    <section className={LIST_SECTION_CLASS}>
      <SectionHeading
        action={
          <Segmented
            label={t(($) => $.activity.filter_label)}
            value={kind}
            onChange={setKind}
            options={FEED_KINDS.map((value) => ({ value, label: kindLabels[value] }))}
          />
        }
      >
        {t(($) => $.activity.heading)}
      </SectionHeading>
      <FeedBody
        query={query}
        transitionOnly={false}
        empty={kind === "all" ? t(($) => $.activity.empty) : t(($) => $.activity.empty_filtered)}
      />
    </section>
  );
}

/**
 * Every status change across the workspace, newest first, each shown as the
 * move itself. The tabs narrow it by the status a change went into.
 */
export function StatusChangesFeed() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const [filter, setFilter] = useState<StatusChangeFilter>("all");
  // Custom statuses come from the catalog, so a category tab waits for it.
  const targets = useMemo(() => statusChangeTargets(filter, catalog), [filter, catalog]);
  const query = useInfiniteQuery({
    ...workspaceActivityOptions(wsId, "status", targets ?? []),
    enabled: targets !== null,
  });
  const filterLabels: Record<StatusChangeFilter, string> = {
    all: t(($) => $.status_changes.filters.all),
    in_progress: t(($) => $.status_changes.filters.in_progress),
    blocked: t(($) => $.status_changes.filters.blocked),
    done: t(($) => $.status_changes.filters.done),
    cancelled: t(($) => $.status_changes.filters.cancelled),
  };

  return (
    <section className={LIST_SECTION_CLASS}>
      <SectionHeading
        action={
          <Segmented
            label={t(($) => $.status_changes.filter_label)}
            value={filter}
            onChange={setFilter}
            options={STATUS_CHANGE_FILTERS.map((value) => ({ value, label: filterLabels[value] }))}
          />
        }
      >
        {t(($) => $.status_changes.heading)}
      </SectionHeading>
      <FeedBody
        query={query}
        transitionOnly
        empty={
          filter === "all" ? t(($) => $.status_changes.empty) : t(($) => $.status_changes.empty_filtered)
        }
      />
    </section>
  );
}

/** A paged feed grouped under day headings, with its loading, error and empty states. */
function FeedBody({
  query,
  transitionOnly,
  empty,
}: {
  query: UseInfiniteQueryResult<WorkspaceActivityEntry[]>;
  transitionOnly: boolean;
  empty: string;
}) {
  const { t } = useT("overview");
  const locale = useLocale();
  const tz = useViewingTimezone();
  const { data: entries, isPending, isError, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const groups = useMemo(() => groupFeedByDay(coalesceFeed(entries ?? []), tz), [entries, tz]);

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
    <div className={LIST_CLASS}>
      {groups.map((group) => (
        <div key={group.day}>
          <div className="sticky top-0 z-10 border-b bg-card px-4 py-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
            {dayLabel(group.day)}
          </div>
          <div className="divide-y">
            {group.entries.map((entry) => (
              <FeedRow key={entry.id} entry={entry} transitionOnly={transitionOnly} />
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

/**
 * `transitionOnly` is the Status changes feed: every row there is a status
 * change, so its second line shows the move itself ("In Review → Todo") and
 * who made it, instead of a sentence.
 */
function FeedRow({ entry, transitionOnly }: { entry: WorkspaceActivityEntry; transitionOnly: boolean }) {
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
  const actorName = entry.actor_name || getActorName(entry.actor_type, entry.actor_id);
  const excerpt = isComment ? commentExcerpt(entry.content ?? "") : "";

  let phrase: string;
  let lead: ReactNode;
  if (isComment) {
    phrase = entry.parent_id ? t(($) => $.activity.replied) : t(($) => $.activity.commented);
    lead = <MessageSquare className="size-4 text-muted-foreground" />;
  } else if (entry.action === "status_changed" && details.to) {
    const status = catalog.labelOf(details.to);
    const category = catalog.categoryOf(details.to);
    phrase =
      category === "done" || category === "closed"
        ? t(($) => $.activity.marked, { status })
        : t(($) => $.activity.moved, { status });
    lead = (
      <StatusIcon
        status={details.to}
        category={category}
        color={catalog.colorOf(details.to)}
        icon={catalog.iconOf(details.to)}
        className="size-4"
      />
    );
  } else if (entry.action === "task_failed") {
    phrase = t(($) => $.activity.run_failed);
    lead = <CircleX className="size-4 text-destructive" />;
  } else {
    phrase = formatActivity(entry, tIssues, locale, getActorName, catalog.labelOf);
    lead =
      entry.action === "created" ? (
        <CirclePlus className="size-4 text-muted-foreground" />
      ) : entry.action === "assignee_changed" ? (
        <UserRound className="size-4 text-muted-foreground" />
      ) : entry.action === "priority_changed" && details.to ? (
        <PriorityIcon priority={details.to} className="size-4" />
      ) : entry.action === "title_changed" || entry.action === "description_updated" ? (
        <Pencil className="size-4 text-muted-foreground" />
      ) : (
        <Activity className="size-4 text-muted-foreground" />
      );
  }
  const href = paths.issueDetail(entry.issue.id) + (isComment ? `#comment-${entry.id}` : "");

  return (
    <AppLink
      href={href}
      className="flex min-w-0 items-start gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50"
    >
      <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {lead}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-label">
          <span className="shrink-0 font-mono text-caption text-muted-foreground">
            {entry.issue.identifier}
          </span>
          <span className="min-w-0 truncate">{entry.issue.title}</span>
          <span className="ml-auto shrink-0 pl-2 text-caption text-muted-foreground">
            {timeAgo(entry.created_at)}
          </span>
        </span>
        {transitionOnly && entry.action === "status_changed" && details.to ? (
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
            {details.from && (
              <>
                <StatusChip statusKey={details.from} />
                <ArrowRight aria-label="→" className="size-3 shrink-0" />
              </>
            )}
            <StatusChip statusKey={details.to} />
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              <ActorAvatar
                actorType={entry.actor_type}
                actorId={entry.actor_id}
                name={entry.actor_name}
                avatarUrl={entry.actor_avatar_url}
                size="xs"
                profileLink={false}
              />
              <span className="font-medium text-foreground">{actorName}</span>
            </span>
          </span>
        ) : (
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
          <ActorAvatar
            actorType={entry.actor_type}
            actorId={entry.actor_id}
            name={entry.actor_name}
            avatarUrl={entry.actor_avatar_url}
            size="xs"
            profileLink={false}
          />
          <span className="shrink-0 font-medium text-foreground">{actorName}</span>
          <span className="min-w-0 truncate">
            {excerpt ? t(($) => $.activity.with_excerpt, { phrase, excerpt }) : phrase}
          </span>
          {(entry.coalesced_count ?? 1) > 1 && (
            <span className="shrink-0 tabular-nums">×{entry.coalesced_count}</span>
          )}
        </span>
        )}
      </span>
    </AppLink>
  );
}

/** A status as its icon and name, resolved through the workspace catalog. */
function StatusChip({ statusKey }: { statusKey: string }) {
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <StatusIcon
        status={statusKey}
        category={catalog.categoryOf(statusKey)}
        color={catalog.colorOf(statusKey)}
        icon={catalog.iconOf(statusKey)}
        className="size-3.5 shrink-0"
      />
      <span className="truncate text-foreground">{catalog.labelOf(statusKey)}</span>
    </span>
  );
}
