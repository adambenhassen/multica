"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, KeyRound } from "lucide-react";
import { agentAccountListOptions } from "@multica/core/agents";
import type { AgentAccount } from "@multica/core/types";
import {
  PickerItem,
  PropertyPicker,
} from "../../../issues/components/pickers";
import { SettingsRow } from "../../../settings/components/settings-layout";
import { useT } from "../../../i18n";

/**
 * Account row for the agent settings form. Hidden while the workspace has no
 * account for this runtime's provider and the agent has none selected, so
 * workspaces that don't use accounts see no extra field.
 */
export function AccountSettingField({
  label,
  wsId,
  provider,
  value,
  canEdit,
  onChange,
}: {
  label: ReactNode;
  wsId: string;
  provider: string;
  value: string | null;
  canEdit: boolean;
  onChange: (next: string | null) => Promise<void> | void;
}) {
  const { data: accounts } = useQuery(agentAccountListOptions(wsId));
  if (!accounts) return null;
  if (!value && !accounts.some((account) => account.provider === provider)) {
    return null;
  }

  return (
    <SettingsRow label={label} size="select-wide">
      <AccountPicker
        accounts={accounts}
        provider={provider}
        value={value}
        canEdit={canEdit}
        onChange={onChange}
      />
    </SettingsRow>
  );
}

export function AccountPicker({
  accounts,
  provider,
  value,
  canEdit,
  onChange,
}: {
  accounts: AgentAccount[];
  provider: string;
  value: string | null;
  canEdit: boolean;
  onChange: (next: string | null) => Promise<void> | void;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const options = accounts.filter((account) => account.provider === provider);
  // A selected account outside the filtered list still shows its name.
  const selected = value
    ? accounts.find((account) => account.id === value)
    : undefined;
  // "Runtime default" means the provider's override account when one is set.
  const override = options.find((account) => account.overrides_runtime_default);
  const defaultLabel = override
    ? t(($) => $.pickers.account_default_override, { name: override.name })
    : t(($) => $.pickers.account_default);
  const triggerLabel = value ? (selected?.name ?? value) : defaultLabel;
  const triggerTitle = t(($) => $.pickers.account_tooltip, {
    value: triggerLabel,
  });

  const select = async (next: string | null) => {
    setOpen(false);
    if (next !== value) await onChange(next);
  };

  if (!canEdit) {
    return (
      <div className="flex min-h-10 items-center gap-2 rounded-lg border border-input bg-input/50 px-3 text-body text-muted-foreground">
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{triggerLabel}</span>
      </div>
    );
  }

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-[var(--anchor-width)] min-w-[14rem] max-w-md"
      align="start"
      tooltip={triggerTitle}
      triggerRender={
        <button
          type="button"
          className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-3 text-left text-body transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={triggerTitle}
        />
      }
      trigger={
        <>
          <KeyRound
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </>
      }
    >
      <PickerItem selected={!value} onClick={() => void select(null)}>
        <span className="truncate text-label font-medium">{defaultLabel}</span>
      </PickerItem>
      {options.map((account) => (
        <PickerItem
          key={account.id}
          selected={account.id === value}
          onClick={() => void select(account.id)}
        >
          <span className="truncate text-label font-medium">
            {account.name}
          </span>
        </PickerItem>
      ))}
    </PropertyPicker>
  );
}
