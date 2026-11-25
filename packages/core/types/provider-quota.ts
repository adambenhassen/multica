export type QuotaProvider = "claude" | "codex";
export type QuotaWindowKind = "session" | "weekly" | "fable";

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /** 0–100. */
  used_percent: number;
  resets_at: string | null;
}

export interface ProviderQuotaAccount {
  id: string;
  provider: QuotaProvider;
  label: string;
  windows: QuotaWindow[];
  /** `"login_expired"`, `"upstream_error"`, or an unknown future code. */
  error: string | null;
  updated_at: string | null;
}

export type ClaudeLimitLevel = "brutal" | "harsh" | "tight" | "fair" | "good" | "great";

/** usage.report's reading of how far Claude quota goes today. */
export interface ClaudeLimit {
  level: ClaudeLimitLevel;
  /** Percent of a usual day's reach; 100 is typical. */
  efficiency: number;
  measured_at: string;
}

export interface ProviderQuotaResponse {
  accounts: ProviderQuotaAccount[];
  /** `null` when no Claude account is listed or the tracker has no recent reading. */
  claude_limit: ClaudeLimit | null;
}
