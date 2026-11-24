import type { AgentTask, IssueCIEntry, IssueCIPullRequest, WakeupPreview, WorkspaceActivityEntry } from "@multica/core/types";
import { BUILT_IN_STATUS_ORDER } from "@multica/core/issues/config";
import type { IssueStatusCatalog } from "@multica/core/issue-statuses";
import { stripMentionMarkdown } from "../issues/utils/strip-mention-markdown";

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

// A duplicate mark change that moved the status stands in for the status row
// and carries the move.
const STATUS_MOVE_ACTIONS = new Set(["status_changed", "duplicate_marked", "duplicate_unmarked"]);

/** Whether a feed row moved its issue's status, and so carries `to`. */
export function isStatusMove(entry: WorkspaceActivityEntry): boolean {
  return entry.type === "activity" && STATUS_MOVE_ACTIONS.has(entry.action ?? "") && !!entry.details?.to;
}

/**
 * Keeps each issue's newest move and drops its older ones, so an issue that
 * moved several times shows once, at its latest move. Its creation counts as
 * its first move: a new issue that has not moved yet keeps that row. Other
 * rows pass through. `entries` are newest first.
 */
export function latestStatusChangePerIssue(entries: WorkspaceActivityEntry[]): WorkspaceActivityEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!isStatusMove(entry) && !(entry.type === "activity" && entry.action === "created")) return true;
    if (seen.has(entry.issue.id)) return false;
    seen.add(entry.issue.id);
    return true;
  });
}

/**
 * A status tab's rows: one per issue whose current status is one of the tab's
 * `targets`, at its latest move into them. An issue that moved on drops out,
 * so the tab lists where issues are now. `entries` (moves into `targets`) are
 * newest first.
 */
export function currentStatusRows(entries: WorkspaceActivityEntry[], targets: readonly string[]): WorkspaceActivityEntry[] {
  const now = new Set(targets);
  return latestRowPerIssue(entries.filter((entry) => now.has(entry.issue.status)));
}

/** Keeps each issue's newest row of any kind. `entries` are newest first. */
export function latestRowPerIssue(entries: WorkspaceActivityEntry[]): WorkspaceActivityEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.issue.id) ? false : (seen.add(entry.issue.id), true)));
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

/** Tabs on the Dashboard's status-changes feed, by the status a change went into. */
export const STATUS_CHANGE_FILTERS = [
  "all",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type StatusChangeFilter = (typeof STATUS_CHANGE_FILTERS)[number];

// Built-in statuses with a tab of their own, left out of their category's tab.
const OWN_TAB = new Set<string>(["backlog", "in_review", "blocked"]);
const STATUS_CHANGE_CATEGORY = { todo: "unstarted", in_progress: "started", done: "done", cancelled: "closed" } as const;

/**
 * The status keys a filter's changes went into, or null while the workspace
 * catalog is still loading. Backlog, In review and Blocked have tabs of their
 * own; Todo is every other unstarted status and In progress every other
 * started one, so custom statuses count by their category. Archived statuses
 * stay in, so changes into them before archiving still show.
 */
export function statusChangeTargets(
  filter: StatusChangeFilter,
  catalog: Pick<IssueStatusCatalog, "statuses" | "categoryOf" | "isLoaded" | "isError">,
): string[] | null {
  if (filter === "all") return [];
  if (filter === "backlog" || filter === "in_review" || filter === "blocked") return [filter];
  // A catalog that cannot be read falls back to the built-in statuses.
  const keys = catalog.isLoaded
    ? catalog.statuses.map((s) => s.key)
    : catalog.isError
      ? [...BUILT_IN_STATUS_ORDER]
      : null;
  if (!keys) return null;
  const category = STATUS_CHANGE_CATEGORY[filter];
  return keys.filter((key) => !OWN_TAB.has(key) && catalog.categoryOf(key) === category);
}

/** Why an issue nobody is running on is waiting, and since (or until) when. */
export type WaitingReason =
  | { kind: "run_queued"; since: string }
  | {
      kind: "ci_queued" | "ci_running" | "ci_failing" | "ci_failed" | "ci_gate";
      since: string | null;
      pullRequest: IssueCIPullRequest;
    }
  | { kind: "wakeup"; wakeup: WakeupPreview };

const CI_KIND = {
  queued: "ci_queued",
  running: "ci_running",
  failing: "ci_failing",
  failed: "ci_failed",
  gate: "ci_gate",
} as const;

const RUNNING_TASK = new Set<AgentTask["status"]>(["running", "waiting_local_directory"]);
const QUEUED_TASK = new Set<AgentTask["status"]>(["queued", "dispatched"]);
// Someone will pick the issue up: a failed CI there is not left unattended.
const PENDING_TASK = new Set<AgentTask["status"]>(["queued", "dispatched", "deferred"]);

/**
 * The issues waiting on something while no agent runs on them: a run queued
 * but not started, CI queued or running on an open PR, failed CI that no run is
 * active or queued to fix, finished CI the merge gate still holds, or an
 * enabled wakeup. Failed or gate-held CI on an issue with a wakeup gives way to
 * the wakeup: the issue is parked on that, not on the PR. Each issue gets the first of
 * those, in that order. CI on an issue whose status `isClosed` is left out;
 * `wakeups` (earliest first per issue) already leaves closed issues out.
 */
export function waitingIssues(
  tasks: readonly Pick<AgentTask, "issue_id" | "status" | "created_at">[],
  ci: readonly IssueCIEntry[],
  wakeups: readonly WakeupPreview[],
  isClosed: (status: string) => boolean,
): Map<string, WaitingReason> {
  const running = new Set<string>();
  const pending = new Set<string>();
  const queuedSince = new Map<string, string>();
  for (const task of tasks) {
    if (!task.issue_id) continue;
    if (RUNNING_TASK.has(task.status)) running.add(task.issue_id);
    if (PENDING_TASK.has(task.status)) pending.add(task.issue_id);
    if (QUEUED_TASK.has(task.status)) {
      const cur = queuedSince.get(task.issue_id);
      if (!cur || task.created_at < cur) queuedSince.set(task.issue_id, task.created_at);
    }
  }
  const out = new Map<string, WaitingReason>();
  for (const [issueId, since] of queuedSince) {
    if (!running.has(issueId)) out.set(issueId, { kind: "run_queued", since });
  }
  const parked = new Set(wakeups.map((w) => w.issue_id));
  for (const entry of ci) {
    const id = entry.issue_id;
    if (running.has(id) || out.has(id) || isClosed(entry.issue_status)) continue;
    // Failed CI that a run is lined up to fix is not left unattended.
    if ((entry.state === "failed" || entry.state === "failing") && pending.has(id)) continue;
    // Settled CI on an issue parked with a wakeup is not what it waits on.
    if ((entry.state === "failed" || entry.state === "gate") && parked.has(id)) continue;
    out.set(id, {
      kind: CI_KIND[entry.state],
      since: entry.since,
      pullRequest: entry.pull_request,
    });
  }
  for (const wakeup of wakeups) {
    if (running.has(wakeup.issue_id) || out.has(wakeup.issue_id)) continue;
    out.set(wakeup.issue_id, { kind: "wakeup", wakeup });
  }
  return out;
}

/** What the Waiting tab can be narrowed to, in its filter's order. */
export const WAITING_GROUPS = [
  "run_queued",
  "ci_queued",
  "ci_running",
  "ci_failing",
  "ci_failed",
  "ci_gate",
  "wakeup_due",
  "wakeup",
] as const;
export type WaitingGroup = (typeof WAITING_GROUPS)[number];

/** The Activity header's waiting chips, in order. */
export const WAITING_CHIPS = ["ci_running", "ci_waiting", "ci_failed", "gate", "scheduled"] as const;
export type WaitingChip = (typeof WAITING_CHIPS)[number];

const CHIP_OF_REASON: Record<WaitingReason["kind"], WaitingChip | null> = {
  // A queued run is about to start: it gets no chip of its own.
  run_queued: null,
  ci_queued: "ci_waiting",
  ci_running: "ci_running",
  // A check failed but others still run: CI is not done yet.
  ci_failing: "ci_running",
  ci_failed: "ci_failed",
  ci_gate: "gate",
  wakeup: "scheduled",
};

/** The header chip a reason counts toward, or null when it has none. */
export function waitingChip(reason: WaitingReason): WaitingChip | null {
  return CHIP_OF_REASON[reason.kind];
}

/**
 * When a scheduled wakeup fires; NaN for an event rule, whose `next_fire_at`
 * is only the server's next condition check.
 */
export function wakeupFireTime(wakeup: Pick<WakeupPreview, "kind" | "next_fire_at">): number {
  return wakeup.kind !== "event" && wakeup.next_fire_at ? Date.parse(wakeup.next_fire_at) : NaN;
}

/** A reason's filter group: a wakeup whose fire time has passed is due. */
export function waitingGroup(reason: WaitingReason, now: number): WaitingGroup {
  if (reason.kind !== "wakeup") return reason.kind;
  const at = wakeupFireTime(reason.wakeup);
  return !Number.isNaN(at) && at <= now ? "wakeup_due" : "wakeup";
}

export type ElapsedParts = { days: number } | { hours: number; minutes: number } | { minutes: number };

/** A span of time, in the largest units that read at a glance. */
export function durationParts(ms: number): ElapsedParts {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 24) return { days: Math.floor(hours / 24) };
  if (hours >= 1) return { hours, minutes: totalMinutes % 60 };
  return { minutes: totalMinutes };
}
