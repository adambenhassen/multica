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

/**
 * Keeps each issue's newest move and drops its older ones, so an issue that
 * moved several times shows once, at its latest move. Its creation counts as
 * its first move: a new issue that has not moved yet keeps that row. Other
 * rows pass through. `entries` are newest first.
 */
export function latestStatusChangePerIssue(entries: WorkspaceActivityEntry[]): WorkspaceActivityEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.type !== "activity" || (entry.action !== "status_changed" && entry.action !== "created")) return true;
    if (seen.has(entry.issue.id)) return false;
    seen.add(entry.issue.id);
    return true;
  });
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
export const STATUS_CHANGE_FILTERS = ["all", "in_progress", "blocked", "done", "cancelled"] as const;
export type StatusChangeFilter = (typeof STATUS_CHANGE_FILTERS)[number];

const STATUS_CHANGE_CATEGORY = { in_progress: "started", done: "done", cancelled: "closed" } as const;

/**
 * The status keys a filter's changes went into, or null while the workspace
 * catalog is still loading. In progress is every started status except
 * Blocked, which has its own tab; custom statuses count by their category.
 * Archived statuses stay in, so changes into them before archiving still show.
 */
export function statusChangeTargets(
  filter: StatusChangeFilter,
  catalog: Pick<IssueStatusCatalog, "statuses" | "categoryOf" | "isLoaded" | "isError">,
): string[] | null {
  if (filter === "all") return [];
  if (filter === "blocked") return ["blocked"];
  // A catalog that cannot be read falls back to the built-in statuses.
  const keys = catalog.isLoaded
    ? catalog.statuses.map((s) => s.key)
    : catalog.isError
      ? [...BUILT_IN_STATUS_ORDER]
      : null;
  if (!keys) return null;
  const category = STATUS_CHANGE_CATEGORY[filter];
  return keys.filter((key) => key !== "blocked" && catalog.categoryOf(key) === category);
}

/** Why an issue nobody is running on is waiting, and since (or until) when. */
export type WaitingReason =
  | { kind: "run_queued"; since: string }
  | { kind: "ci_queued" | "ci_running" | "ci_failed" | "ci_gate"; since: string | null; pullRequest: IssueCIPullRequest }
  | { kind: "wakeup"; wakeup: WakeupPreview };

const CI_KIND = { queued: "ci_queued", running: "ci_running", failed: "ci_failed", gate: "ci_gate" } as const;

const RUNNING_TASK = new Set<AgentTask["status"]>(["running", "waiting_local_directory"]);
const QUEUED_TASK = new Set<AgentTask["status"]>(["queued", "dispatched"]);
// Someone will pick the issue up: a failed CI there is not left unattended.
const PENDING_TASK = new Set<AgentTask["status"]>(["queued", "dispatched", "deferred"]);

/**
 * The issues waiting on something while no agent runs on them: a run queued
 * but not started, CI queued or running on an open PR, failed CI that no run is
 * active or queued to fix, finished CI the merge gate still holds, or an
 * enabled wakeup. Each issue gets the first of
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
  for (const entry of ci) {
    const id = entry.issue_id;
    if (running.has(id) || out.has(id) || isClosed(entry.issue_status)) continue;
    if (entry.state === "failed" && pending.has(id)) continue;
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

export type ElapsedParts = { days: number } | { hours: number; minutes: number } | { minutes: number };

/** A span of time, in the largest units that read at a glance. */
export function durationParts(ms: number): ElapsedParts {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 24) return { days: Math.floor(hours / 24) };
  if (hours >= 1) return { hours, minutes: totalMinutes % 60 };
  return { minutes: totalMinutes };
}
