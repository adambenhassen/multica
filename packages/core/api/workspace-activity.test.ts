// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const entry = {
  type: "activity",
  id: "act-1",
  actor_type: "member",
  actor_id: "user-1",
  actor_name: "Ada",
  created_at: "2026-10-01T10:00:00Z",
  action: "status_changed",
  details: { from: "todo", to: "in_progress" },
  issue: { id: "issue-1", identifier: "MUL-1", title: "Ship it", status: "in_progress" },
};

afterEach(() => vi.unstubAllGlobals());

async function read(
  body: unknown,
  limit?: number,
  kind?: "all" | "comments" | "status" | "failures",
  before?: string,
) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const result = await new ApiClient("https://api.example.test").listWorkspaceActivity({ limit, kind, before });
  return { result, url: String(fetch.mock.calls[0]?.[0]) };
}

describe("workspace activity API", () => {
  it("parses entries and passes the limit", async () => {
    const { result, url } = await read({ entries: [entry] }, 10);
    expect(result.entries).toEqual([entry]);
    expect(url).toContain("/api/activity?limit=10");
  });

  it("passes the page cursor and reads the next one", async () => {
    const { result, url } = await read({ entries: [entry], next_cursor: "2026-10-01T10:00:00Z|act-1" }, 50, "all", "c1");
    expect(url).toContain("before=c1");
    expect(result.next_cursor).toBe("2026-10-01T10:00:00Z|act-1");
  });

  it("sends a narrowing kind but not the default", async () => {
    expect((await read({ entries: [] }, 50, "comments")).url).toContain("kind=comments");
    expect((await read({ entries: [] }, 50, "all")).url).not.toContain("kind=");
  });

  it("sends the status keys a change went into, and nothing when there are none", async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.listWorkspaceActivity({ kind: "status", to: ["in_progress", "in_review"] });
    await client.listWorkspaceActivity({ kind: "status", to: [] });
    const urls = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams);
    expect(urls[0]?.get("to")).toBe("in_progress,in_review");
    expect(urls[1]?.has("to")).toBe(false);
  });

  it("asks for the issues still in those statuses only with a status filter", async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.listWorkspaceActivity({ kind: "status", to: ["blocked"], current: true });
    await client.listWorkspaceActivity({ kind: "status", to: [], current: true });
    await client.listWorkspaceActivity({ kind: "status", to: ["blocked"] });
    const urls = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams);
    expect(urls[0]?.get("current")).toBe("1");
    expect(urls[1]?.has("current")).toBe(false);
    expect(urls[2]?.has("current")).toBe(false);
  });

  it("sends the issue and project to narrow the feed to", async () => {
    const { url } = await read({ entries: [] }, 50, "all");
    expect(url).not.toContain("issue=");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await new ApiClient("https://api.example.test").listWorkspaceActivity({ issues: ["issue-1", "issue-2"], project: "project-1" });
    const params = new URL(String(fetch.mock.calls[0]?.[0])).searchParams;
    expect(params.get("issue")).toBe("issue-1,issue-2");
    expect(params.get("project")).toBe("project-1");
  });

  // One bad row must not blank the whole feed.
  it("drops a malformed row and keeps the valid ones", async () => {
    const { result } = await read({
      entries: [entry, { ...entry, id: "act-2", issue: null }, { id: 3 }],
    });
    expect(result.entries.map((e) => e.id)).toEqual(["act-1"]);
  });

  it("keeps a row whose priority is malformed, without the priority", async () => {
    const { result } = await read({
      entries: [{ ...entry, issue: { ...entry.issue, priority: "high" } }, { ...entry, id: "act-2", issue: { ...entry.issue, priority: 3 } }],
    });
    expect(result.entries.map((e) => e.issue.priority)).toEqual(["high", undefined]);
  });

  it.each([null, [], "nope", { entries: "nope" }])(
    "falls back to an empty feed for %j",
    async (body) => {
      expect((await read(body)).result).toEqual({ entries: [], next_cursor: null });
    },
  );
});

describe("activity pins API", () => {
  async function listPins(body: unknown) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    return new ApiClient("https://api.example.test").listActivityPins();
  }

  it("reads the pinned issue ids and drops non-string ones", async () => {
    expect(await listPins({ issue_ids: ["issue-1", 2, null, "issue-2"] })).toEqual(["issue-1", "issue-2"]);
  });

  it.each([null, [], "nope", { issue_ids: "nope" }])("falls back to no pins for %j", async (body) => {
    expect(await listPins(body)).toEqual([]);
  });

  it("pins with PUT and unpins with DELETE on the issue's path", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.pinActivityIssue("issue-1");
    await client.unpinActivityIssue("issue-1");
    const calls = fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, (init as RequestInit).method]);
    expect(calls).toEqual([
      ["/api/activity/pins/issue-1", "PUT"],
      ["/api/activity/pins/issue-1", "DELETE"],
    ]);
  });
});

// The issue-list buckets depend on this filter reaching the server. Without it
// every bucket returned the same unfiltered page, so each issue appeared once
// per bucket wherever the buckets were flattened.
describe("listIssues category filters", () => {
  it("sends status_category and status_categories", async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.listIssues({ status_category: "done" });
    await client.listIssues({ status_categories: ["started", "closed"] });
    const urls = fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams);
    expect(urls[0]?.get("status_category")).toBe("done");
    expect(urls[1]?.get("status_categories")).toBe("started,closed");
  });
});
