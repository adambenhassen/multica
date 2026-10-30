import type { ProviderQuotaAccount, QuotaWindow, QuotaWindowKind } from "@multica/core/types";

const PROVIDER_ORDER = { claude: 0, codex: 1 } as const;

export function sortQuotaAccounts(accounts: ProviderQuotaAccount[]): ProviderQuotaAccount[] {
  return [...accounts].sort(
    (a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider] || a.label.localeCompare(b.label),
  );
}

export function quotaLevel(usedPercent: number): "normal" | "warning" | "critical" {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
}

export type ResetParts =
  | { days: number }
  | { hours: number; minutes: number }
  | { minutes: number }
  | "soon"
  | null;

export function resetParts(resetsAt: string | null, now: number): ResetParts {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at) || at <= now) return null;
  const totalMinutes = Math.floor((at - now) / 60_000);
  if (totalMinutes < 1) return "soon";
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 24) return { days: Math.floor(hours / 24) };
  if (hours >= 1) return { hours, minutes: totalMinutes % 60 };
  return { minutes: totalMinutes };
}

const WINDOW_MS: Record<QuotaWindowKind, number> = {
  session: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  fable: 7 * 86_400_000,
};
// Pace right after a reset is noise: a few points of use read as a huge deficit.
const MIN_EXPECTED_PERCENT = 3;
const ON_TRACK_POINTS = 2;

export interface QuotaPace {
  /** Even-burn target at `now`, 0–100. */
  expected: number;
  /** used − expected; positive is ahead of pace. */
  delta: number;
  stage: "on_track" | "deficit" | "reserve";
  /** Time until 100% at the current rate: 0 when exhausted, null when it lasts until reset. */
  runsOutInMs: number | null;
}

export function quotaPace(window: QuotaWindow, now: number): QuotaPace | null {
  const duration = WINDOW_MS[window.kind];
  if (!duration || !window.resets_at) return null;
  const resetsAt = Date.parse(window.resets_at);
  if (Number.isNaN(resetsAt)) return null;
  const elapsed = Math.min(duration, Math.max(0, duration - (resetsAt - now)));
  const expected = (elapsed / duration) * 100;
  if (expected < MIN_EXPECTED_PERCENT) return null;
  const used = window.used_percent;
  const delta = used - expected;
  const stage = Math.abs(delta) <= ON_TRACK_POINTS ? "on_track" : delta > 0 ? "deficit" : "reserve";
  let runsOutInMs: number | null = null;
  if (used >= 100) runsOutInMs = 0;
  else if (used > 0) {
    const eta = ((100 - used) / used) * elapsed;
    if (eta < resetsAt - now) runsOutInMs = eta;
  }
  return { expected, delta, stage, runsOutInMs };
}
