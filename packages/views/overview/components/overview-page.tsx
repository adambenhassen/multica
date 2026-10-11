"use client";

import { useMemo, type ReactNode } from "react";
import { Bot, CircleDot, DollarSign, Inbox, LayoutDashboard, type LucideIcon } from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { CurrencyNumberFlow } from "@multica/ui/components/ui/number-flow";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentTaskSnapshotOptions, useWorkspacePresenceMap } from "@multica/core/agents";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  issueDetailOptions,
  issueListOptions,
  issueTableFacetsOptions,
  type IssueSortParam,
} from "@multica/core/issues/queries";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useInboxUnreadCount } from "@multica/core/inbox/queries";
import { dashboardRunTimeDailyOptions, dashboardUsageDailyOptions } from "@multica/core/dashboard";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import { workspaceActivityOptions } from "@multica/core/overview";
import type { AgentTask, Issue, IssueTableFacetsRequest } from "@multica/core/types";
import { AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { CollectionPageHeader } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { StatusIcon } from "../../issues/components/status-icon";
import { formatActivity } from "../../issues/utils/format-activity";
import { taskStatusConfig } from "../../agents/config";
import { DailyTasksChart } from "../../runtimes/components/charts";
import { addDaysIso, todayIso } from "../../runtimes/utils";
import { computeDailyTotals } from "../../dashboard/utils";
import { useLocale, useT, useTimeAgo } from "../../i18n";
import {
  OVERVIEW_CHART_DAYS,
  fillRunSeries,
  pickRunCards,
  successRateSeries,
  summarizeAgents,
  summarizeIssueFacet,
} from "../utils";
import { SuccessRateChart } from "./success-rate-chart";
import { cn } from "@multica/ui/lib/utils";

const LIST_LIMIT = 10;
const SPEND_DAYS = 30;

const STATUS_FACET_REQUEST: IssueTableFacetsRequest = {
  query: {
    scope: { kind: "workspace" },
    filters: {},
    sort: { field: "position", direction: "asc" },
  },
  facets: [{ kind: "status" }],
  include_total: false,
};

const RECENT_ISSUES_SORT: IssueSortParam = { sort_by: "updated_at", sort_direction: "desc" };

const LIST_CLASS = "divide-y overflow-hidden rounded-lg border bg-card";
const LIST_ROW_CLASS =
  "flex min-h-12 items-center gap-3 px-4 py-3 text-label transition-colors hover:bg-accent/50";

export function OverviewPage() {
  const { t } = useT("overview");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader icon={LayoutDashboard} title={t(($) => $.title)} />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("space-y-6 py-6", PAGE_GUTTER)}>
          <AgentRunsPanel />
          <MetricCards />
          <ChartsRow />
          <div className="grid gap-4 md:grid-cols-2">
            <RecentActivityList />
            <RecentIssuesList />
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-label font-semibold uppercase tracking-wide text-muted-foreground">
        {children}
      </h2>
      {action}
    </div>
  );
}

function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border p-4 text-label text-muted-foreground">{children}</div>
  );
}

// A failed section says so and offers a retry; rendering it as empty would
// read as "nothing happened" (e.g. an older server without /api/activity).
function ErrorBox({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("overview");
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border p-4 text-label text-muted-foreground">
      <span>{t(($) => $.load_failed)}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t(($) => $.retry)}
      </Button>
    </div>
  );
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={LIST_CLASS} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-12 items-center gap-3 px-4 py-3">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent runs
// ---------------------------------------------------------------------------

function AgentRunsPanel() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const snapshotQuery = useQuery(agentTaskSnapshotOptions(wsId));
  const runs = useMemo(() => pickRunCards(snapshotQuery.data ?? []), [snapshotQuery.data]);
  const issueQueries = useQueries({
    queries: runs
      .filter((run) => run.issue_id !== "")
      .map((run) => issueDetailOptions(wsId, run.issue_id)),
  });
  const issues = new Map<string, Issue>();
  for (const q of issueQueries) if (q.data) issues.set(q.data.id, q.data);
  const issuesLoading = issueQueries.some((q) => q.isPending);

  return (
    <section>
      <SectionHeading
        action={
          <AppLink
            href={paths.agents()}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            {t(($) => $.agents.view_all)}
          </AppLink>
        }
      >
        {t(($) => $.agents.heading)}
      </SectionHeading>
      {snapshotQuery.isPending ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : snapshotQuery.isError ? (
        <ErrorBox onRetry={() => void snapshotQuery.refetch()} />
      ) : runs.length === 0 ? (
        <EmptyBox>{t(($) => $.agents.empty)}</EmptyBox>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} issue={issues.get(run.issue_id)} issueLoading={issuesLoading} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunCard({
  run,
  issue,
  issueLoading,
}: {
  run: AgentTask;
  issue: Issue | undefined;
  issueLoading: boolean;
}) {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const catalog = useIssueStatuses(wsId);
  const { getActorName } = useActorName();
  const cfg = taskStatusConfig[run.status] ?? taskStatusConfig.queued!;
  const Icon = cfg.icon;
  const isRunning = run.status === "running";

  const timeText = run.completed_at
    ? t(($) => $.agents.finished_ago, { time: timeAgo(run.completed_at) })
    : run.started_at
      ? t(($) => $.agents.started_ago, { time: timeAgo(run.started_at) })
      : t(($) => $.agents.queued_ago, { time: timeAgo(run.created_at) });

  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border bg-card px-4 py-3", isRunning && "border-brand/40")}>
      <div className="flex min-w-0 items-center gap-2">
        <ActorAvatar actorType="agent" actorId={run.agent_id} size="sm" profileLink={false} />
        <span className="min-w-0 flex-1 truncate text-label font-medium">
          {getActorName("agent", run.agent_id)}
        </span>
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            cfg.color,
            isRunning && "animate-spin motion-reduce:animate-none",
          )}
        />
      </div>
      {issue ? (
        <AppLink
          href={paths.issueDetail(issue.id)}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-caption hover:text-foreground"
        >
          <StatusIcon
            status={issue.status}
            category={catalog.categoryOf(issue.status)}
            color={catalog.colorOf(issue.status)}
            icon={catalog.iconOf(issue.status)}
            className="size-3.5 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          <span className="shrink-0 font-mono text-muted-foreground">{issue.identifier}</span>
        </AppLink>
      ) : (
        <span className="text-caption text-muted-foreground">
          {run.issue_id && issueLoading ? " " : t(($) => $.agents.no_issue)}
        </span>
      )}
      <span className="text-caption text-muted-foreground">{timeText}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric cards
// ---------------------------------------------------------------------------

function MetricCards() {
  const { t } = useT("overview");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const tz = useViewingTimezone();
  const catalog = useIssueStatuses(wsId);

  const presence = useWorkspacePresenceMap(wsId);
  const agents = useMemo(() => summarizeAgents(presence.byAgent.values()), [presence.byAgent]);

  const facetsQuery = useQuery(issueTableFacetsOptions(wsId, STATUS_FACET_REQUEST));
  const statusValues = facetsQuery.data?.facets.find((f) => f.kind === "status")?.values;
  const issues = useMemo(
    () => summarizeIssueFacet(statusValues ?? [], catalog.categoryOf),
    [statusValues, catalog.categoryOf],
  );

  // Saved model prices change the estimate; re-render when they do.
  useCustomPricingStore((s) => s.pricings);
  const usageQuery = useQuery(dashboardUsageDailyOptions(wsId, SPEND_DAYS, null, tz));
  const usageRows = usageQuery.data;
  const spend = useMemo(() => {
    const cutoff = addDaysIso(todayIso(tz), -(SPEND_DAYS - 1));
    return computeDailyTotals((usageRows ?? []).filter((u) => u.date >= cutoff)).cost;
  }, [usageRows, tz]);

  const unread = useInboxUnreadCount(wsId);

  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      <MetricCard
        href={paths.agents()}
        icon={Bot}
        label={t(($) => $.metrics.agents_online)}
        loading={presence.loading}
        value={agents.online.toLocaleString(locale)}
        description={t(($) => $.metrics.agents_desc, {
          working: agents.working,
          queued: agents.queued,
          offline: agents.offline,
        })}
      />
      <MetricCard
        href={paths.issues()}
        icon={CircleDot}
        label={t(($) => $.metrics.issues_in_progress)}
        loading={facetsQuery.isPending}
        value={facetsQuery.isError ? "—" : issues.inProgress.toLocaleString(locale)}
        description={
          facetsQuery.isError
            ? t(($) => $.load_failed)
            : t(($) => $.metrics.issues_desc, { todo: issues.todo, blocked: issues.blocked })
        }
      />
      <MetricCard
        href={paths.usage()}
        icon={DollarSign}
        label={t(($) => $.metrics.spend)}
        loading={usageQuery.isPending}
        value={usageQuery.isError ? "—" : <CurrencyNumberFlow value={spend} locales={locale} />}
        description={usageQuery.isError ? t(($) => $.load_failed) : t(($) => $.metrics.spend_desc)}
      />
      <MetricCard
        href={paths.inbox()}
        icon={Inbox}
        label={t(($) => $.metrics.inbox)}
        value={unread.toLocaleString(locale)}
      />
    </div>
  );
}

function MetricCard({
  href,
  icon: Icon,
  label,
  value,
  description,
  loading = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  description?: string;
  loading?: boolean;
}) {
  return (
    <AppLink
      href={href}
      className="relative flex flex-col gap-1 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
    >
      <Icon aria-hidden="true" className="absolute top-4 right-4 size-4 text-muted-foreground" />
      <span className="text-display font-semibold leading-none tabular-nums">
        {loading ? <Skeleton className="h-7 w-12" /> : value}
      </span>
      <span className="text-label text-muted-foreground">{label}</span>
      {description && (
        <span className="hidden truncate text-caption text-muted-foreground sm:block">
          {loading ? " " : description}
        </span>
      )}
    </AppLink>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function ChartsRow() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const tz = useViewingTimezone();
  const runsQuery = useQuery(dashboardRunTimeDailyOptions(wsId, OVERVIEW_CHART_DAYS, null, tz));
  const runRows = runsQuery.data;
  const runSeries = useMemo(() => fillRunSeries(runRows ?? [], todayIso(tz)), [runRows, tz]);
  const rateSeries = useMemo(() => successRateSeries(runSeries), [runSeries]);
  const hasRuns = runSeries.some((d) => d.completed + d.failed + d.cancelled > 0);

  const body = (chart: ReactNode) =>
    runsQuery.isPending ? (
      <Skeleton className="aspect-[3/1] w-full" />
    ) : runsQuery.isError ? (
      <ErrorBox onRetry={() => void runsQuery.refetch()} />
    ) : hasRuns ? (
      chart
    ) : (
      <div className="flex aspect-[3/1] items-center justify-center text-caption text-muted-foreground">
        {t(($) => $.charts.no_runs)}
      </div>
    );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ChartCard title={t(($) => $.charts.run_activity)}>
        {body(<DailyTasksChart data={runSeries} />)}
      </ChartCard>
      <ChartCard title={t(($) => $.charts.success_rate)}>
        {body(<SuccessRateChart data={rateSeries} />)}
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useT("overview");
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h3 className="text-caption font-medium text-muted-foreground">{title}</h3>
        <p className="text-micro text-muted-foreground">{t(($) => $.charts.last_14_days)}</p>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent activity / issues
// ---------------------------------------------------------------------------

function RecentActivityList() {
  const { t } = useT("overview");
  const { t: tIssues } = useT("issues");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const catalog = useIssueStatuses(wsId);
  const { getActorName } = useActorName();
  const { data: entries, isPending, isError, refetch } = useQuery(workspaceActivityOptions(wsId, LIST_LIMIT));

  return (
    <section>
      <SectionHeading>{t(($) => $.activity.heading)}</SectionHeading>
      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorBox onRetry={() => void refetch()} />
      ) : !entries || entries.length === 0 ? (
        <EmptyBox>{t(($) => $.activity.empty)}</EmptyBox>
      ) : (
        <div className={LIST_CLASS}>
          {entries.map((entry) => (
            <AppLink key={entry.id} href={paths.issueDetail(entry.issue.id)} className={LIST_ROW_CLASS}>
              <ActorAvatar
                actorType={entry.actor_type}
                actorId={entry.actor_id}
                name={entry.actor_name}
                avatarUrl={entry.actor_avatar_url}
                size="sm"
                profileLink={false}
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">
                  {entry.actor_name || getActorName(entry.actor_type, entry.actor_id)}
                </span>{" "}
                <span className="text-muted-foreground">
                  {formatActivity(entry, tIssues, locale, getActorName, catalog.labelOf)}
                </span>{" "}
                <span>{entry.issue.title}</span>
              </span>
              <span className="hidden shrink-0 font-mono text-caption text-muted-foreground sm:inline">
                {entry.issue.identifier}
              </span>
              <span className="w-16 shrink-0 text-right text-caption text-muted-foreground">
                {timeAgo(entry.created_at)}
              </span>
            </AppLink>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentIssuesList() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const catalog = useIssueStatuses(wsId);
  const { data, isPending, isError, refetch } = useQuery(issueListOptions(wsId, RECENT_ISSUES_SORT));
  // The list cache is bucketed by status, each bucket sorted on its own; the
  // newest across buckets has to be picked here.
  const issues = useMemo(
    () =>
      (data ?? [])
        .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, LIST_LIMIT),
    [data],
  );

  return (
    <section>
      <SectionHeading>{t(($) => $.issues.heading)}</SectionHeading>
      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorBox onRetry={() => void refetch()} />
      ) : issues.length === 0 ? (
        <EmptyBox>{t(($) => $.issues.empty)}</EmptyBox>
      ) : (
        <div className={LIST_CLASS}>
          {issues.map((issue) => (
            <AppLink key={issue.id} href={paths.issueDetail(issue.id)} className={LIST_ROW_CLASS}>
              <StatusIcon
                status={issue.status}
                category={catalog.categoryOf(issue.status)}
                color={catalog.colorOf(issue.status)}
                icon={catalog.iconOf(issue.status)}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
              {issue.assignee_type && issue.assignee_id && (
                <ActorAvatar
                  actorType={issue.assignee_type}
                  actorId={issue.assignee_id}
                  size="sm"
                  profileLink={false}
                />
              )}
              <span className="hidden shrink-0 font-mono text-caption text-muted-foreground sm:inline">
                {issue.identifier}
              </span>
              <span className="w-16 shrink-0 text-right text-caption text-muted-foreground">
                {timeAgo(issue.updated_at)}
              </span>
            </AppLink>
          ))}
        </div>
      )}
    </section>
  );
}
