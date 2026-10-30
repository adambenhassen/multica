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

const ROW_CLASS = "col-span-full grid grid-cols-subgrid items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring";

export function ProviderQuotaPanel() {
  const { t } = useT("layout");
  const { data } = useQuery(providerQuotaOptions());
  const accounts = data?.accounts ?? [];
  if (accounts.length === 0) return null;

  const perProvider = new Map<string, number>();
  for (const a of accounts) perProvider.set(a.provider, (perProvider.get(a.provider) ?? 0) + 1);
  // Header rows are panel-wide: a provider name squeezed into column 1 next to
  // another provider's labelled headers truncates to its first letter.
  const headerRows = [...perProvider.values()].some((n) => n > 1);

  return (
    <div
      role="group"
      aria-label={t(($) => $.quota.label)}
      className="@container max-h-56 overflow-y-auto px-2 pt-0.5 pb-1"
    >
      <div
        className={cn(
          "grid gap-x-1.5 gap-y-0.5 text-caption text-muted-foreground",
          headerRows
            ? "grid-cols-[auto_minmax(1.5rem,1fr)_auto] @min-[13rem]:grid-cols-[auto_minmax(1.5rem,1fr)_auto_auto]"
            : "grid-cols-[minmax(0.75rem,auto)_auto_minmax(1.5rem,1fr)_auto] @min-[13rem]:grid-cols-[minmax(0.75rem,auto)_auto_minmax(1.5rem,1fr)_auto_auto]",
        )}
      >
        {sortQuotaAccounts(accounts).map((account) => (
          <AccountRows
            key={account.id}
            account={account}
            labelled={(perProvider.get(account.provider) ?? 0) > 1}
            headerRow={headerRows}
          />
        ))}
      </div>
    </div>
  );
}

function AccountRows({
  account,
  labelled,
  headerRow,
}: {
  account: ProviderQuotaAccount;
  labelled: boolean;
  headerRow: boolean;
}) {
  const { t } = useT("layout");
  const providerName = PROVIDER_NAME[account.provider];
  const name = labelled ? `${providerName} · ${account.label}` : providerName;
  const header = headerRow ? (
    <span title={name} className="col-span-full min-w-0 truncate text-foreground">
      {name}
    </span>
  ) : null;
  // With header rows there is no name column, so rows sit flush under their header.
  const nameCell = (show: boolean) =>
    headerRow ? null : (
      <span title={show ? name : undefined} className="min-w-0 truncate text-foreground">
        {show ? name : ""}
      </span>
    );

  if (account.error || account.windows.length === 0) {
    const message =
      account.error === "login_expired" ? t(($) => $.quota.login_expired) : t(($) => $.quota.unavailable);
    return (
      <>
        {header}
        <Tooltip>
          <TooltipTrigger render={<div tabIndex={0} className={ROW_CLASS} />}>
            {nameCell(!headerRow)}
            <span className={headerRow ? "col-span-full" : "col-[2/-1]"}>—</span>
            <span className="sr-only">{message}</span>
          </TooltipTrigger>
          <TooltipContent>{message}</TooltipContent>
        </Tooltip>
      </>
    );
  }

  return (
    <>
      {header}
      {account.windows.map((window, i) => (
        <WindowRow key={`${window.kind}-${i}`} name={name} window={window} nameCell={nameCell(!headerRow && i === 0)} />
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
  const kindLabel =
    window.kind === "session"
      ? t(($) => $.quota.session)
      : window.kind === "fable"
        ? t(($) => $.quota.fable)
        : t(($) => $.quota.weekly);

  const row = (
    <>
      {nameCell}
      <span className="whitespace-nowrap">{kindLabel}</span>
      <div
        role="progressbar"
        aria-label={`${name} ${kindLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div className={cn("h-full", BAR_CLASS[quotaLevel(pct)])} style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-right tabular-nums">{pct}%</span>
      <span className="hidden whitespace-nowrap text-right tabular-nums @min-[13rem]:block">{reset}</span>
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
