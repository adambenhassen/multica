// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
  return new ApiClient("https://api.example.test").getIssueCI();
}

const entry = {
  issue_id: "issue-1",
  issue_status: "in_review",
  state: "running",
  since: "2026-10-30T06:00:00Z",
  pull_request: {
    provider: "gitea",
    repo_owner: "acme",
    repo_name: "widget",
    number: 7,
    html_url: "https://gitea.test/acme/widget/pulls/7",
  },
};

describe("issue CI API", () => {
  it("keeps a well-formed entry", async () => {
    expect(await read({ issues: [entry] })).toEqual({ issues: [entry] });
  });

  it.each(["queued", "gate"])("keeps a %s entry", async (state) => {
    expect(await read({ issues: [{ ...entry, state }] })).toEqual({ issues: [{ ...entry, state }] });
  });

  it("drops entries with an unknown state or no issue id", async () => {
    const { issue_id: _id, ...noId } = entry;
    expect(await read({ issues: [{ ...entry, state: "passed" }, { ...entry, state: "pending" }, noId] })).toEqual({ issues: [] });
  });

  it("defaults missing optional fields", async () => {
    const got = await read({ issues: [{ issue_id: "issue-2", state: "failed", pull_request: {} }] });
    expect(got.issues[0]).toEqual({
      issue_id: "issue-2",
      issue_status: "",
      state: "failed",
      since: null,
      pull_request: { provider: "", repo_owner: "", repo_name: "", number: 0, html_url: "" },
    });
  });

  it.each([[null], [[]], ["x"], [{ issues: "nope" }]])("falls back to an empty list for %j", async (bad) => {
    expect(await read(bad)).toEqual({ issues: [] });
  });

  it("returns an empty list when the backend predates the route (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    expect(await new ApiClient("https://api.example.test").getIssueCI()).toEqual({ issues: [] });
  });

  it("still throws on other HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(new ApiClient("https://api.example.test").getIssueCI()).rejects.toThrow();
  });
});
