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

async function read(body: unknown, limit?: number, kind?: "all" | "comments" | "status") {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const result = await new ApiClient("https://api.example.test").listWorkspaceActivity({ limit, kind });
  return { result, url: String(fetch.mock.calls[0]?.[0]) };
}

describe("workspace activity API", () => {
  it("parses entries and passes the limit", async () => {
    const { result, url } = await read({ entries: [entry] }, 10);
    expect(result.entries).toEqual([entry]);
    expect(url).toContain("/api/activity?limit=10");
  });

  it("sends a narrowing kind but not the default", async () => {
    expect((await read({ entries: [] }, 50, "comments")).url).toContain("kind=comments");
    expect((await read({ entries: [] }, 50, "all")).url).not.toContain("kind=");
  });

  // One bad row must not blank the whole feed.
  it("drops a malformed row and keeps the valid ones", async () => {
    const { result } = await read({
      entries: [entry, { ...entry, id: "act-2", issue: null }, { id: 3 }],
    });
    expect(result.entries.map((e) => e.id)).toEqual(["act-1"]);
  });

  it.each([null, [], "nope", { entries: "nope" }])(
    "falls back to an empty feed for %j",
    async (body) => {
      expect((await read(body)).result).toEqual({ entries: [] });
    },
  );
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
