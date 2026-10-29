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

export interface ProviderQuotaResponse {
  accounts: ProviderQuotaAccount[];
}
