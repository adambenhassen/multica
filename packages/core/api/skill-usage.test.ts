// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
  return new ApiClient("https://api.example.test").listSkillUsage();
}

describe("skill usage API", () => {
  it("keeps count and last use", async () => {
    const row = { skill_id: "s", run_count: 4, last_used_at: "2026-10-16T09:30:00Z" };
    expect(await read([row])).toEqual([row]);
  });

  it.each([undefined, null, 42])("reads last_used_at %s as null", async (bad) => {
    expect(await read([{ skill_id: "s", run_count: 0, last_used_at: bad }])).toEqual([
      { skill_id: "s", run_count: 0, last_used_at: null },
    ]);
  });

  it.each([-1, 1.5, "3", null])("reads run_count %s as 0", async (bad) => {
    expect(await read([{ skill_id: "s", run_count: bad, last_used_at: null }])).toEqual([
      { skill_id: "s", run_count: 0, last_used_at: null },
    ]);
  });

  it("falls back for a malformed list", async () => {
    expect(await read({ usage: [] })).toEqual([]);
  });
});
