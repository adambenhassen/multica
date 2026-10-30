// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProviderQuotaAccount, QuotaWindow } from "@multica/core/types";
import { quotaLevel, quotaPace, resetParts, sortQuotaAccounts } from "./provider-quota-format";

const acct = (provider: "claude" | "codex", label: string): ProviderQuotaAccount => ({
  id: `${provider}-${label}`, provider, label, windows: [], error: null, updated_at: null,
});

describe("sortQuotaAccounts", () => {
  it("orders Claude before Codex, then by label", () => {
    const got = sortQuotaAccounts([acct("codex", "a"), acct("claude", "work"), acct("claude", "personal")]);
    expect(got.map((a) => a.id)).toEqual(["claude-personal", "claude-work", "codex-a"]);
  });
});

describe("quotaLevel", () => {
  it.each([[0, "normal"], [79.9, "normal"], [80, "warning"], [94.9, "warning"], [95, "critical"], [100, "critical"]] as const)(
    "%s%% is %s", (pct, want) => expect(quotaLevel(pct)).toBe(want),
  );
});

describe("resetParts", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  it.each([
    ["2026-11-02T13:00:00Z", { days: 4 }],
    ["2026-10-30T12:00:00Z", { days: 1 }],
    ["2026-10-29T14:10:30Z", { hours: 2, minutes: 10 }],
    ["2026-10-29T12:10:00Z", { minutes: 10 }],
    ["2026-10-29T12:00:30Z", "soon"],
    ["2026-10-29T11:00:00Z", null],
    [null, null],
    ["not a date", null],
  ] as const)("%s → %j", (at, want) => expect(resetParts(at, now)).toEqual(want));
});

describe("quotaPace", () => {
  const NOW = Date.parse("2026-10-29T12:00:00Z");
  // Resets in 2.5h: half of the 5h session window elapsed, expected 50.
  const session = (used: number, resets_at: string | null = "2026-10-29T14:30:00Z"): QuotaWindow => ({
    kind: "session", used_percent: used, resets_at,
  });

  it("is ahead of pace and projects the run-out time", () => {
    const pace = quotaPace(session(62), NOW)!;
    expect(pace.expected).toBeCloseTo(50);
    expect(pace.delta).toBeCloseTo(12);
    expect(pace.stage).toBe("deficit");
    expect(pace.runsOutInMs).toBeCloseTo((38 / 62) * 9_000_000);
  });

  it.each([[51, "on_track"], [48, "on_track"], [30, "reserve"]] as const)("%s%% used is %s", (used, stage) => {
    expect(quotaPace(session(used), NOW)!.stage).toBe(stage);
  });

  it("lasts until reset when the projection passes the reset", () => {
    expect(quotaPace(session(30), NOW)!.runsOutInMs).toBeNull();
    expect(quotaPace(session(0), NOW)!.runsOutInMs).toBeNull();
  });

  it("runs out now when exhausted", () => {
    expect(quotaPace(session(100), NOW)!.runsOutInMs).toBe(0);
  });

  it("is undefined without a reset or right after one", () => {
    expect(quotaPace(session(50, null), NOW)).toBeNull();
    expect(quotaPace(session(50, "not a date"), NOW)).toBeNull();
    // Weekly window 1h in: expected 0.6%, below the 3% floor.
    expect(quotaPace({ kind: "weekly", used_percent: 5, resets_at: "2026-11-05T11:00:00Z" }, NOW)).toBeNull();
  });
});
