// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import type { IssueStatusEntry, WorkspaceActivityEntry } from "@multica/core/types";
import { coalesceFeed, commentExcerpt, groupFeedByDay, statusChangeTargets } from "./utils";

describe("commentExcerpt", () => {
  it("reads as one line of plain text", () => {
    expect(
      commentExcerpt(
        "## Done\n\nMerged **#42** for [@Ada](mention://member/u1), see [docs](https://x).\n```go\nfmt.Println()\n```\n- keep issue_id intact ![shot](a.png)",
      ),
    ).toBe("Done Merged #42 for @Ada, see docs. keep issue_id intact");
  });
});

describe("feed shaping", () => {
  const entry = (id: string, over: Partial<WorkspaceActivityEntry> = {}): WorkspaceActivityEntry => ({
    type: "activity",
    id,
    actor_type: "member",
    actor_id: "u1",
    created_at: "2026-10-12T10:00:00Z",
    action: "description_updated",
    issue: { id: "i1", identifier: "MUL-1", title: "T", status: "todo" },
    ...over,
  });

  it("folds consecutive autosaves by the same actor on the same issue", () => {
    const out = coalesceFeed([
      entry("a"),
      entry("b"),
      entry("c", { actor_id: "u2" }),
      entry("d", { action: "status_changed" }),
      entry("e", { action: "status_changed" }),
    ]);
    expect(out.map((e) => [e.id, e.coalesced_count ?? 1])).toEqual([["a", 2], ["c", 1], ["d", 1], ["e", 1]]);
  });

  it("groups by calendar day in the viewer's timezone", () => {
    const groups = groupFeedByDay(
      [
        entry("late", { created_at: "2026-10-12T01:00:00Z" }),
        entry("early", { created_at: "2026-10-11T23:30:00Z" }),
      ],
      "Europe/Berlin",
    );
    expect(groups.map((g) => [g.day, g.entries.map((e) => e.id)])).toEqual([["2026-10-12", ["late", "early"]]]);
  });
});

describe("statusChangeTargets", () => {
  const entry = (key: string, category: string, archived = false) =>
    ({ key, category, archived_at: archived ? "2026-10-01T00:00:00Z" : null }) as IssueStatusEntry;
  const catalog = buildIssueStatusCatalog([
    entry("todo", "unstarted"),
    entry("in_progress", "started"),
    entry("qa", "started"),
    entry("blocked", "started"),
    entry("done", "done"),
    entry("shipped", "done", true),
    entry("cancelled", "closed"),
  ]);

  it("narrows by the category a change went into, keeping Blocked separate", () => {
    expect(statusChangeTargets("all", catalog)).toEqual([]);
    expect(statusChangeTargets("blocked", catalog)).toEqual(["blocked"]);
    expect(statusChangeTargets("in_progress", catalog)).toEqual(["in_progress", "qa"]);
    expect(statusChangeTargets("done", catalog)).toEqual(["done", "shipped"]);
    expect(statusChangeTargets("cancelled", catalog)).toEqual(["cancelled"]);
  });

  it("waits for the catalog, then falls back to built-ins when it fails", () => {
    expect(statusChangeTargets("in_progress", buildIssueStatusCatalog(undefined))).toBeNull();
    expect(statusChangeTargets("blocked", buildIssueStatusCatalog(undefined))).toEqual(["blocked"]);
    const failed = buildIssueStatusCatalog(undefined, { isError: true });
    expect(statusChangeTargets("in_progress", failed)).toEqual(["in_progress", "in_review"]);
    expect(statusChangeTargets("cancelled", failed)).toEqual(["cancelled"]);
  });
});
