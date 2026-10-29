import type { ProviderQuotaAccount } from "@multica/core/types";

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
