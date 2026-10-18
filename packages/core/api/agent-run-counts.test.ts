// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
  return new ApiClient("https://api.example.test").getWorkspaceAgentRunCounts();
}

describe("agent run counts API", () => {
  it("keeps the last run time", async () => {
    const row = { agent_id: "a", run_count: 3, last_hour_count: 1, last_run_at: "2026-10-16T09:30:00Z" };
    expect(await read([row])).toEqual([row]);
  });

  it.each([undefined, null, 42])("reads last_run_at %s as null", async (bad) => {
    expect(await read([{ agent_id: "a", run_count: 0, last_hour_count: 0, last_run_at: bad }])).toEqual([
      { agent_id: "a", run_count: 0, last_hour_count: 0, last_run_at: null },
    ]);
  });

  it.each([undefined, null, -1])("reads last_hour_count %s as 0", async (bad) => {
    expect(await read([{ agent_id: "a", run_count: 2, last_hour_count: bad, last_run_at: null }])).toEqual([
      { agent_id: "a", run_count: 2, last_hour_count: 0, last_run_at: null },
    ]);
  });

  it("falls back for a malformed list", async () => {
    expect(await read({ counts: [] })).toEqual([]);
  });
});
