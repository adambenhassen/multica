import type { AgentPresenceDetail } from "@multica/core/agents";
import type {
  WorkspaceActivityEntry,
  AgentTask,
  DashboardRunTimeDaily,
  IssueStatusCategory,
  IssueTableFacetValue,
} from "@multica/core/types";
import type { DailyTasksData } from "../runtimes/components/charts";
import { aggregateDailyTasks, formatDateLabel } from "../dashboard/utils";
import { addDaysIso } from "../runtimes/utils";
import { stripMentionMarkdown } from "../issues/utils/strip-mention-markdown";

export const OVERVIEW_CHART_DAYS = 14;

/**
 * One bar per day for the `days` days ending at `today` (YYYY-MM-DD), so a
 * day without runs renders as an empty slot instead of collapsing the axis.
 */
export function fillRunSeries(
  rows: DashboardRunTimeDaily[],
  today: string,
  days: number = OVERVIEW_CHART_DAYS,
): DailyTasksData[] {
  const byDate = new Map(aggregateDailyTasks(rows).map((d) => [d.date, d]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDaysIso(today, i - (days - 1));
    return (
      byDate.get(date) ?? {
        date,
        label: formatDateLabel(date),
        completed: 0,
        failed: 0,
        cancelled: 0,
      }
    );
  });
}

export type SuccessTone = "success" | "warning" | "destructive";

export interface SuccessRatePoint {
  date: string;
  label: string;
  /** Percentage 0–100, or null on a day with no finished outcome. */
  rate: number | null;
}

/**
 * Completed share of runs that reached an outcome. A cancel is a stop, not an
 * outcome, so cancelled runs count toward neither side.
 */
export function successRateSeries(series: DailyTasksData[]): SuccessRatePoint[] {
  return series.map(({ date, label, completed, failed }) => {
    const finished = completed + failed;
    return {
      date,
      label,
      rate: finished === 0 ? null : Math.round((completed / finished) * 100),
    };
  });
}

export function successTone(rate: number): SuccessTone {
  if (rate >= 80) return "success";
  if (rate >= 50) return "warning";
  return "destructive";
}

export interface AgentSummary {
  online: number;
  offline: number;
  working: number;
  queued: number;
}

/** Counts live agents by presence. Archived agents are retired, not offline. */
export function summarizeAgents(presence: Iterable<AgentPresenceDetail>): AgentSummary {
  const summary: AgentSummary = { online: 0, offline: 0, working: 0, queued: 0 };
  for (const p of presence) {
    if (p.availability === "archived") continue;
    if (p.availability === "online") summary.online += 1;
    else summary.offline += 1;
    if (p.workload === "working") summary.working += 1;
    else if (p.workload === "queued") summary.queued += 1;
  }
  return summary;
}

export interface IssueSummary {
  inProgress: number;
  todo: number;
  blocked: number;
}

/**
 * Folds a status facet into the three counts the metric card shows. Custom
 * statuses resolve through the workspace catalog, so a custom "QA" status in
 * the started category counts as in progress. Backlog is parked work, not
 * to-do; blocked is called out rather than counted as progress.
 */
export function summarizeIssueFacet(
  values: IssueTableFacetValue[],
  categoryOf: (statusKey: string) => IssueStatusCategory,
): IssueSummary {
  const summary: IssueSummary = { inProgress: 0, todo: 0, blocked: 0 };
  for (const { key, count } of values) {
    if (key === "blocked") summary.blocked += count;
    else if (key === "backlog") continue;
    else if (categoryOf(key) === "started") summary.inProgress += count;
    else if (categoryOf(key) === "unstarted") summary.todo += count;
  }
  return summary;
}

const ACTIVE_RUN_ORDER: AgentTask["status"][] = [
  "running",
  "dispatched",
  "waiting_local_directory",
  "queued",
  "deferred",
];

/**
 * The runs worth a card: active ones first (running before waiting), then the
 * most recently finished. Chat runs belong to their conversation, not to the
 * workspace's work, so they are left out.
 */
export function pickRunCards(snapshot: AgentTask[], limit = 4): AgentTask[] {
  const work = snapshot.filter((task) => !task.chat_session_id);
  const active = work
    .filter((task) => ACTIVE_RUN_ORDER.includes(task.status))
    .toSorted((a, b) => ACTIVE_RUN_ORDER.indexOf(a.status) - ACTIVE_RUN_ORDER.indexOf(b.status));
  const finished = work
    .filter((task) => !ACTIVE_RUN_ORDER.includes(task.status))
    .toSorted((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  return [...active, ...finished].slice(0, limit);
}

/**
 * One line of plain text from a comment's markdown, for the activity feed.
 * Mentions keep their label; code blocks and images drop out; link text stays.
 */
export function commentExcerpt(markdown: string): string {
  return stripMentionMarkdown(markdown)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|~~|`|\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Description edits autosave and agents retry failed runs, so both write runs
// of identical rows.
const COALESCED_FEED_ACTIONS = new Set(["description_updated", "task_failed"]);

/** Folds consecutive repeats of an autosaved edit into one row with a count. */
export function coalesceFeed(entries: WorkspaceActivityEntry[]): WorkspaceActivityEntry[] {
  const out: WorkspaceActivityEntry[] = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      entry.type === "activity" &&
      prev.type === "activity" &&
      COALESCED_FEED_ACTIONS.has(entry.action ?? "") &&
      prev.action === entry.action &&
      prev.actor_type === entry.actor_type &&
      prev.actor_id === entry.actor_id &&
      prev.issue.id === entry.issue.id
    ) {
      out[out.length - 1] = { ...prev, coalesced_count: (prev.coalesced_count ?? 1) + 1 };
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** The calendar day (YYYY-MM-DD) an instant falls on in `tz`. */
export function dayInTimezone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Splits a newest-first feed into runs of the same calendar day. */
export function groupFeedByDay(
  entries: WorkspaceActivityEntry[],
  tz: string,
): { day: string; entries: WorkspaceActivityEntry[] }[] {
  const groups: { day: string; entries: WorkspaceActivityEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayInTimezone(entry.created_at, tz);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}
