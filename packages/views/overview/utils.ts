import type { WorkspaceActivityEntry } from "@multica/core/types";
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
 * Keeps each issue's newest status change and drops its older ones, so an
 * issue that moved several times shows once, at its latest move. Other rows
 * pass through. `entries` are newest first.
 */
export function latestStatusChangePerIssue(entries: WorkspaceActivityEntry[]): WorkspaceActivityEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.type !== "activity" || entry.action !== "status_changed") return true;
    if (seen.has(entry.issue.id)) return false;
    seen.add(entry.issue.id);
    return true;
  });
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
