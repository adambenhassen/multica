// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProviderQuotaAccount } from "@multica/core/types";
import { quotaLevel, resetParts, sortQuotaAccounts } from "./provider-quota-format";

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
