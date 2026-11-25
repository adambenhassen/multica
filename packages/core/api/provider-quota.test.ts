// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
  return new ApiClient("https://api.example.test").getProviderQuota();
}

const account = {
  id: "claude-personal",
  provider: "claude",
  label: "personal",
  windows: [
    { kind: "session", used_percent: 42, resets_at: "2026-10-29T14:10:00Z" },
    { kind: "weekly", used_percent: 18, resets_at: "2026-11-02T09:00:00Z" },
  ],
  error: null,
  updated_at: "2026-10-29T12:00:00Z",
};

describe("provider quota API", () => {
  it("keeps a well-formed account", async () => {
    expect(await read({ accounts: [account] })).toEqual({ accounts: [account], claude_limit: null });
  });

  it("drops accounts with an unknown provider", async () => {
    expect(await read({ accounts: [{ ...account, provider: "gemini" }] })).toEqual({ accounts: [], claude_limit: null });
  });

  it("keeps a fable window", async () => {
    const fable = { kind: "fable", used_percent: 55, resets_at: "2026-11-02T20:00:00Z" };
    const got = await read({ accounts: [{ ...account, windows: [...account.windows, fable] }] });
    expect(got.accounts[0]!.windows).toEqual([...account.windows, fable]);
  });

  it("drops windows with an unknown kind", async () => {
    const got = await read({
      accounts: [{ ...account, windows: [{ kind: "monthly", used_percent: 1, resets_at: null }, account.windows[1]] }],
    });
    expect(got.accounts[0]!.windows).toEqual([account.windows[1]]);
  });

  it.each([[-5, 0], [140, 100], ["7", 0]])("clamps used_percent %s to %s", async (bad, want) => {
    const got = await read({
      accounts: [{ ...account, windows: [{ kind: "weekly", used_percent: bad, resets_at: null }] }],
    });
    expect(got.accounts[0]!.windows[0]!.used_percent).toBe(want);
  });

  it("defaults missing error, label and updated_at", async () => {
    const { error: _e, updated_at: _u, label: _l, ...rest } = account;
    const got = await read({ accounts: [rest] });
    expect(got.accounts[0]).toMatchObject({ error: null, updated_at: null, label: "" });
  });

  it.each([[null], [[]], ["x"], [{ accounts: "nope" }]])("falls back to an empty list for %j", async (bad) => {
    expect(await read(bad)).toEqual({ accounts: [], claude_limit: null });
  });

  it("keeps a well-formed Claude limit", async () => {
    const claude_limit = { level: "tight", efficiency: 85, measured_at: "2026-11-24T18:57:00Z" };
    expect((await read({ accounts: [account], claude_limit })).claude_limit).toEqual(claude_limit);
  });

  it.each([
    ["an unknown level", { level: "meh", efficiency: 85, measured_at: "2026-11-24T18:57:00Z" }],
    ["a zero efficiency", { level: "fair", efficiency: 0, measured_at: "2026-11-24T18:57:00Z" }],
    ["no measured_at", { level: "fair", efficiency: 100 }],
    ["a string", "tight"],
  ])("drops a Claude limit with %s but keeps the accounts", async (_, claude_limit) => {
    expect(await read({ accounts: [account], claude_limit })).toEqual({ accounts: [account], claude_limit: null });
  });

  it("returns an empty list when the backend predates the route (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    expect(await new ApiClient("https://api.example.test").getProviderQuota()).toEqual({ accounts: [], claude_limit: null });
  });

  it("still throws on other HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(new ApiClient("https://api.example.test").getProviderQuota()).rejects.toThrow();
  });
});
