// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const rows = await new ApiClient("https://api.example.test").listSkillAgentUsage("skill-1");
  return { rows, url: fetchMock.mock.calls[0]![0] as string };
}

describe("skill agent usage API", () => {
  it("requests the skill's usage and keeps count and last use", async () => {
    const row = { agent_id: "a", run_count: 4, last_used_at: "2026-10-16T09:30:00Z" };
    const { rows, url } = await read([row]);
    expect(url).toBe("https://api.example.test/api/skills/skill-1/usage");
    expect(rows).toEqual([row]);
  });

  it.each([undefined, null, 42])("reads last_used_at %s as null", async (bad) => {
    expect((await read([{ agent_id: "a", run_count: 0, last_used_at: bad }])).rows).toEqual([
      { agent_id: "a", run_count: 0, last_used_at: null },
    ]);
  });

  it.each([-1, 1.5, "3", null])("reads run_count %s as 0", async (bad) => {
    expect((await read([{ agent_id: "a", run_count: bad, last_used_at: null }])).rows).toEqual([
      { agent_id: "a", run_count: 0, last_used_at: null },
    ]);
  });

  it("falls back for a malformed list", async () => {
    expect((await read({ usage: [] })).rows).toEqual([]);
  });
});
