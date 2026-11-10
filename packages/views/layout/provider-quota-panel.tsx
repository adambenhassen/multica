import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "@multica/ui/icons";
import { providerQuotaOptions, useProviderQuotaPanelStore } from "@multica/core/provider-quota";
import type { ProviderQuotaAccount, QuotaWindow, QuotaWindowKind } from "@multica/core/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../i18n";
import { quotaLevel, quotaPace, resetParts, sortQuotaAccounts, type ResetParts } from "./provider-quota-format";

const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

const BAR_CLASS = {
  normal: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

const LEVEL_TEXT_CLASS = {
  normal: "text-foreground",
  warning: "text-warning",
  critical: "text-destructive",
} as const;

const ROW_CLASS = "col-span-full grid grid-cols-subgrid items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring";

const percent = (window: QuotaWindow) => Math.min(100, Math.max(0, Math.round(window.used_percent)));

/** A window's name and a time until reset, in the viewer's words. */
function useQuotaText() {
  const { t } = useT("layout");
  return {
    kind: (kind: QuotaWindowKind) =>
      kind === "session" ? t(($) => $.quota.session) : kind === "fable" ? t(($) => $.quota.fable) : t(($) => $.quota.weekly),
    duration: (parts: ResetParts) =>
      parts === null
        ? ""
        : parts === "soon"
          ? t(($) => $.quota.reset_soon)
          : "days" in parts
            ? t(($) => $.quota.reset_days, { days: parts.days })
            : "hours" in parts
              ? t(($) => $.quota.reset_hours, { hours: parts.hours, minutes: parts.minutes })
              : t(($) => $.quota.reset_minutes, { minutes: parts.minutes }),
  };
}

export function ProviderQuotaPanel({
  defaultCollapsed = false,
}: {
  /**
   * Start folded to the summary line until the viewer chooses otherwise. For
   * the phone's nav sheet, where every row at once crowds out the navigation.
   */
  defaultCollapsed?: boolean;
}) {
  const { t } = useT("layout");
  const { data } = useQuery(providerQuotaOptions());
  const choice = useProviderQuotaPanelStore((s) => s.collapsed);
  const setCollapsed = useProviderQuotaPanelStore((s) => s.setCollapsed);
  const collapsed = choice ?? defaultCollapsed;
  const accounts = data?.accounts ?? [];
  if (accounts.length === 0) return null;

  const perProvider = new Map<string, number>();
  for (const a of accounts) perProvider.set(a.provider, (perProvider.get(a.provider) ?? 0) + 1);
  // Header rows are panel-wide: a provider name squeezed into column 1 next to
  // another provider's labelled headers truncates to its first letter.
  const headerRows = [...perProvider.values()].some((n) => n > 1);

  const panel = (
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
  return (
    <div>
      <QuotaSummary accounts={accounts} expanded={!collapsed} onToggle={() => setCollapsed(!collapsed)} />
      {collapsed ? null : panel}
    </div>
  );
}

/**
 * The panel's heading and fold control. Folded, it names the fullest window
 * across every account, since that is the one about to matter; open, the rows
 * below say it all.
 */
function QuotaSummary({
  accounts,
  expanded,
  onToggle,
}: {
  accounts: ProviderQuotaAccount[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("layout");
  const text = useQuotaText();
  let fullest: QuotaWindow | null = null;
  for (const account of accounts) {
    for (const window of account.windows) {
      if (!fullest || window.used_percent > fullest.used_percent) fullest = window;
    }
  }
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-caption text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <span className="mr-auto min-w-0 truncate">{t(($) => $.quota.label)}</span>
      {expanded ? null : fullest ? (
        <>
          <span className={cn("tabular-nums", LEVEL_TEXT_CLASS[quotaLevel(percent(fullest))])}>
            {percent(fullest)}%
          </span>
          <span className="whitespace-nowrap">{text.kind(fullest.kind)}</span>
          <span className="whitespace-nowrap tabular-nums">
            {text.duration(resetParts(fullest.resets_at, Date.now()))}
          </span>
        </>
      ) : (
        <span>—</span>
      )}
      <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")} />
    </button>
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
  const text = useQuotaText();
  const now = Date.now();
  const pct = percent(window);
  const durationText = text.duration;
  const reset = durationText(resetParts(window.resets_at, now));
  const pace = quotaPace(window, now);
  const paceText = pace
    ? t(($) => $.quota.pace_line, {
        pace:
          pace.stage === "on_track"
            ? t(($) => $.quota.pace_on_track)
            : pace.stage === "deficit"
              ? t(($) => $.quota.pace_deficit, { percent: Math.round(pace.delta) })
              : t(($) => $.quota.pace_reserve, { percent: Math.round(-pace.delta) }),
        runway:
          pace.runsOutInMs === null
            ? t(($) => $.quota.lasts_until_reset)
            : pace.runsOutInMs === 0
              ? t(($) => $.quota.runs_out_now)
              : t(($) => $.quota.runs_out_in, {
                  time: durationText(resetParts(new Date(now + pace.runsOutInMs).toISOString(), now)),
                }),
      })
    : "";
  const kindLabel = text.kind(window.kind);

  const row = (
    <>
      {nameCell}
      <span className="whitespace-nowrap">{kindLabel}</span>
      <div className="relative">
        <div
          role="progressbar"
          aria-label={`${name} ${kindLabel}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={paceText ? `${pct}% · ${paceText}` : undefined}
          className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
        >
          <div className={cn("h-full", BAR_CLASS[quotaLevel(pct)])} style={{ width: `${pct}%` }} />
        </div>
        {pace && pace.stage !== "on_track" ? (
          <span
            aria-hidden
            data-pace-tick={pace.stage}
            className={cn(
              "absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full ring-1 ring-sidebar",
              pace.stage === "deficit" ? "bg-destructive" : "bg-success",
            )}
            style={{ left: `${pace.expected}%` }}
          />
        ) : null}
      </div>
      <span className="whitespace-nowrap text-right tabular-nums">{pct}%</span>
      <span className="hidden whitespace-nowrap text-right tabular-nums @min-[13rem]:block">{reset}</span>
    </>
  );

  if (!window.resets_at) return <div className={ROW_CLASS}>{row}</div>;
  return (
    <Tooltip>
      <TooltipTrigger render={<div tabIndex={0} className={ROW_CLASS} />}>{row}</TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <p>
          {t(($) => $.quota.resets_at, {
            time: new Date(window.resets_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
          })}
        </p>
        {paceText ? <p>{paceText}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
