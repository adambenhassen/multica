"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Bot, CircleDot, DollarSign, Inbox, LayoutDashboard, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { CurrencyNumberFlow } from "@multica/ui/components/ui/number-flow";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentTaskSnapshotOptions, useWorkspacePresenceMap } from "@multica/core/agents";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  issueDetailOptions,
  issueTableFacetsOptions,
} from "@multica/core/issues/queries";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useInboxUnreadCount } from "@multica/core/inbox/queries";
import { dashboardRunTimeDailyOptions, dashboardUsageDailyOptions } from "@multica/core/dashboard";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import {
  OVERVIEW_SECTIONS,
  RECENT_ISSUE_FILTERS,
  recentIssuesOptions,
  useOverviewLayoutStore,
  type OverviewSection,
  type RecentIssueFilter,
} from "@multica/core/overview";
import type { AgentTask, Issue, IssueTableFacetsRequest } from "@multica/core/types";
import { AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { CollectionPageHeader, CollectionPageHeaderAction } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { StatusIcon } from "../../issues/components/status-icon";
import { taskStatusConfig } from "../../agents/config";
import { DailyTasksChart } from "../../runtimes/components/charts";
import { addDaysIso, todayIso } from "../../runtimes/utils";
import { computeDailyTotals } from "../../dashboard/utils";
import { Segmented } from "../../dashboard/components/dashboard-shared";
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
import { ActivityFeed } from "./activity-feed";
import {
  EmptyBox,
  ErrorBox,
  LIST_CLASS,
  LIST_ROW_CLASS,
  ListSkeleton,
  SectionHeading,
} from "./section-parts";
import { cn } from "@multica/ui/lib/utils";

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



export function OverviewPage() {
  const { t } = useT("overview");
  const hidden = useOverviewLayoutStore((s) => s.hidden);
  const showAll = useOverviewLayoutStore((s) => s.showAll);
  // Hidden sections are not rendered at all, so they also stop fetching.
  const shown = (section: OverviewSection) => !hidden.includes(section);
  const listCount = Number(shown("activity")) + Number(shown("issues"));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={LayoutDashboard}
        title={t(($) => $.title)}
        actions={<CustomizeMenu />}
      />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("space-y-6 py-6", PAGE_GUTTER)}>
          {OVERVIEW_SECTIONS.every((section) => !shown(section)) && (
            <div className="flex items-center justify-between gap-2 rounded-lg border p-4 text-label text-muted-foreground">
              <span>{t(($) => $.customize.all_hidden)}</span>
              <Button variant="ghost" size="sm" onClick={showAll}>
                {t(($) => $.customize.show_all)}
              </Button>
            </div>
          )}
          {shown("agents") && <AgentRunsPanel />}
          {shown("metrics") && <MetricCards />}
          {(shown("run_activity") || shown("success_rate")) && (
            <ChartsRow showRuns={shown("run_activity")} showRate={shown("success_rate")} />
          )}
          {listCount > 0 && (
            <div className={cn("grid gap-4", listCount === 2 && "md:grid-cols-2")}>
              {shown("activity") && <ActivityFeed />}
              {shown("issues") && <RecentIssuesList />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomizeMenu() {
  const { t } = useT("overview");
  const hidden = useOverviewLayoutStore((s) => s.hidden);
  const toggleSection = useOverviewLayoutStore((s) => s.toggleSection);
  const showAll = useOverviewLayoutStore((s) => s.showAll);
  const sectionLabels: Record<OverviewSection, string> = {
    agents: t(($) => $.agents.heading),
    metrics: t(($) => $.customize.metrics),
    run_activity: t(($) => $.charts.run_activity),
    success_rate: t(($) => $.charts.success_rate),
    activity: t(($) => $.activity.heading),
    issues: t(($) => $.issues.heading),
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <CollectionPageHeaderAction icon={SlidersHorizontal} label={t(($) => $.customize.button)} />
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.customize.label)}</DropdownMenuLabel>
          {OVERVIEW_SECTIONS.map((section) => (
            <DropdownMenuCheckboxItem
              key={section}
              checked={!hidden.includes(section)}
              onCheckedChange={() => toggleSection(section)}
            >
              {sectionLabels[section]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {hidden.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={showAll}>{t(($) => $.customize.show_all)}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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

function ChartsRow({ showRuns, showRate }: { showRuns: boolean; showRate: boolean }) {
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

  // A lone chart keeps its half-width slot: stretched full width at 3:1 it
  // would push everything below it off screen.
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {showRuns && (
        <ChartCard title={t(($) => $.charts.run_activity)}>
          {body(<DailyTasksChart data={runSeries} />)}
        </ChartCard>
      )}
      {showRate && (
        <ChartCard title={t(($) => $.charts.success_rate)}>
          {body(<SuccessRateChart data={rateSeries} />)}
        </ChartCard>
      )}
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

function RecentIssuesList() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const catalog = useIssueStatuses(wsId);
  const [filter, setFilter] = useState<RecentIssueFilter>("all");
  const { data: issues = [], isPending, isError, refetch } = useQuery(recentIssuesOptions(wsId, filter));
  const filterLabels: Record<RecentIssueFilter, string> = {
    all: t(($) => $.issues.filters.all),
    in_progress: t(($) => $.issues.filters.in_progress),
    blocked: t(($) => $.issues.filters.blocked),
    done: t(($) => $.issues.filters.done),
    cancelled: t(($) => $.issues.filters.cancelled),
  };

  return (
    <section>
      <SectionHeading
        action={
          <Segmented
            label={t(($) => $.issues.filter_label)}
            value={filter}
            onChange={setFilter}
            options={RECENT_ISSUE_FILTERS.map((value) => ({ value, label: filterLabels[value] }))}
          />
        }
      >
        {t(($) => $.issues.heading)}
      </SectionHeading>
      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorBox onRetry={() => void refetch()} />
      ) : issues.length === 0 ? (
        <EmptyBox>
          {filter === "all" ? t(($) => $.issues.empty) : t(($) => $.issues.empty_filtered)}
        </EmptyBox>
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
