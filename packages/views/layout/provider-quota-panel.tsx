import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { providerQuotaOptions } from "@multica/core/provider-quota";
import type { ProviderQuotaAccount, QuotaWindow } from "@multica/core/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../i18n";
import { quotaLevel, resetParts, sortQuotaAccounts } from "./provider-quota-format";

const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

const BAR_CLASS = {
  normal: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

const ROW_CLASS = "col-span-5 grid grid-cols-subgrid items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring";

export function ProviderQuotaPanel() {
  const { t } = useT("layout");
  const { data } = useQuery(providerQuotaOptions());
  const accounts = data?.accounts ?? [];
  if (accounts.length === 0) return null;

  const perProvider = new Map<string, number>();
  for (const a of accounts) perProvider.set(a.provider, (perProvider.get(a.provider) ?? 0) + 1);

  return (
    <div
      role="group"
      aria-label={t(($) => $.quota.label)}
      className="max-h-40 overflow-y-auto px-2 pt-0.5 pb-1"
    >
      <div className="grid grid-cols-[minmax(0,7rem)_auto_minmax(2rem,1fr)_auto_auto] gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
        {sortQuotaAccounts(accounts).map((account) => (
          <AccountRows
            key={account.id}
            account={account}
            name={
              (perProvider.get(account.provider) ?? 0) > 1
                ? `${PROVIDER_NAME[account.provider]} · ${account.label}`
                : PROVIDER_NAME[account.provider]
            }
          />
        ))}
      </div>
    </div>
  );
}

function AccountRows({ account, name }: { account: ProviderQuotaAccount; name: string }) {
  const { t } = useT("layout");
  const nameCell = (show: boolean) => (
    <span title={show ? name : undefined} className="min-w-0 truncate text-foreground">
      {show ? name : ""}
    </span>
  );

  if (account.error || account.windows.length === 0) {
    const message =
      account.error === "login_expired" ? t(($) => $.quota.login_expired) : t(($) => $.quota.unavailable);
    return (
      <Tooltip>
        <TooltipTrigger render={<div tabIndex={0} className={ROW_CLASS} />}>
          {nameCell(true)}
          <span className="col-span-4">—</span>
          <span className="sr-only">{message}</span>
        </TooltipTrigger>
        <TooltipContent>{message}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      {account.windows.map((window, i) => (
        <WindowRow key={window.kind} name={name} window={window} nameCell={nameCell(i === 0)} />
      ))}
    </>
  );
}

function WindowRow({
  window,
  name,
  nameCell,
}: {
  window: QuotaWindow;
  name: string;
  nameCell: ReactNode;
}) {
  const { t } = useT("layout");
  const locale = useLocale();
  const pct = Math.min(100, Math.max(0, Math.round(window.used_percent)));
  const parts = resetParts(window.resets_at, Date.now());
  const reset =
    parts === null
      ? ""
      : parts === "soon"
        ? t(($) => $.quota.reset_soon)
        : "days" in parts
          ? t(($) => $.quota.reset_days, { days: parts.days })
          : "hours" in parts
            ? t(($) => $.quota.reset_hours, { hours: parts.hours, minutes: parts.minutes })
            : t(($) => $.quota.reset_minutes, { minutes: parts.minutes });
  const kindLabel = window.kind === "session" ? t(($) => $.quota.session) : t(($) => $.quota.weekly);

  const row = (
    <>
      {nameCell}
      <span>{kindLabel}</span>
      <div
        role="progressbar"
        aria-label={`${name} ${kindLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full", BAR_CLASS[quotaLevel(pct)])} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right tabular-nums">{pct}%</span>
      <span className="text-right tabular-nums">{reset}</span>
    </>
  );

  if (!window.resets_at) return <div className={ROW_CLASS}>{row}</div>;
  return (
    <Tooltip>
      <TooltipTrigger render={<div tabIndex={0} className={ROW_CLASS} />}>{row}</TooltipTrigger>
      <TooltipContent>
        {t(($) => $.quota.resets_at, {
          time: new Date(window.resets_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
        })}
      </TooltipContent>
    </Tooltip>
  );
}
