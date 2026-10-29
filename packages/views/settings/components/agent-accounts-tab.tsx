"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IdCard, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  agentAccountListOptions,
  useCreateAgentAccount,
  useDeleteAgentAccount,
  useUpdateAgentAccount,
} from "@multica/core/agents";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useCurrentMember } from "@multica/core/permissions";
import { providerDisplayName, runtimeListOptions } from "@multica/core/runtimes";
import type { AgentAccount } from "@multica/core/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { useT } from "../../i18n";
import {
  SettingsCard,
  SettingsReadOnlyNotice,
  SettingsSection,
  SettingsTab,
} from "./settings-layout";

// Server-side marker meaning "keep the stored value for this key".
const KEEP_VALUE = "****";

/**
 * Workspace agent accounts: named env sets (e.g. one OAuth token each) that
 * an agent can select. Values are write-only — the API returns key names,
 * never values — so an edit shows stored keys with empty inputs and only
 * sends the values someone retyped.
 */
export function AgentAccountsTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const currentMember = useCurrentMember(wsId);
  const canManage =
    currentMember.role === "owner" || currentMember.role === "admin";

  const accountsQuery = useQuery(agentAccountListOptions(wsId));
  const accounts = accountsQuery.data ?? [];
  const deleteAccount = useDeleteAgentAccount(wsId);

  const [editor, setEditor] = useState<{ account: AgentAccount | null } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<AgentAccount | null>(null);

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteAccount.mutateAsync(deleting.id);
      toast.success(t(($) => $.agent_accounts.deleted_toast));
      setDeleting(null);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.agent_accounts.delete_failed_toast),
      );
    }
  };

  return (
    <SettingsTab
      title={t(($) => $.page.tabs.agent_accounts)}
      description={t(($) => $.agent_accounts.description)}
      scope="workspace"
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setEditor({ account: null })}>
            <Plus className="h-4 w-4" />
            {t(($) => $.agent_accounts.add)}
          </Button>
        ) : null
      }
    >
      {!canManage && !currentMember.isLoading ? (
        <SettingsReadOnlyNotice wsId={wsId} />
      ) : null}
      <SettingsSection>
        <SettingsCard>
          {accountsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <IdCard className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-3 text-body font-medium">
                {t(($) => $.agent_accounts.empty_title)}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-surface-border">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <ProviderLogo provider={account.provider} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium">
                      {account.name}
                    </p>
                    <p className="truncate text-caption text-muted-foreground">
                      {providerDisplayName(account.provider)} ·{" "}
                      {t(($) => $.agent_accounts.key_count, {
                        count: account.env_key_count,
                      })}
                    </p>
                  </div>
                  {canManage ? (
                    <>
                      <IconButton
                        variant="ghost"
                        size="icon-sm"
                        label={t(($) => $.agent_accounts.edit_aria, {
                          name: account.name,
                        })}
                        onClick={() => setEditor({ account })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        label={t(($) => $.agent_accounts.delete_aria, {
                          name: account.name,
                        })}
                        onClick={() => setDeleting(account)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </SettingsSection>

      {editor ? (
        <AgentAccountDialog
          wsId={wsId}
          account={editor.account}
          onClose={() => setEditor(null)}
        />
      ) : null}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.agent_accounts.delete_title, {
                name: deleting?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.agent_accounts.delete_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAccount.isPending}>
              {t(($) => $.agent_accounts.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              disabled={deleteAccount.isPending}
            >
              {deleteAccount.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t(($) => $.agent_accounts.delete_confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsTab>
  );
}

let nextRowId = 0;

interface EnvRow {
  id: number;
  key: string;
  value: string;
  /** Key already stored on the server; an empty value keeps it. */
  stored: boolean;
}

function AgentAccountDialog({
  wsId,
  account,
  onClose,
}: {
  wsId: string;
  account: AgentAccount | null;
  onClose: () => void;
}) {
  const { t } = useT("settings");
  const createAccount = useCreateAgentAccount(wsId);
  const updateAccount = useUpdateAgentAccount(wsId);
  const { data: runtimes = [] } = useQuery({
    ...runtimeListOptions(wsId),
    enabled: !!wsId,
  });

  const [name, setName] = useState(account?.name ?? "");
  const [provider, setProvider] = useState(account?.provider ?? "");
  const [rows, setRows] = useState<EnvRow[]>(() =>
    account && account.env_keys.length > 0
      ? account.env_keys.map((key) => ({
          id: nextRowId++,
          key,
          value: "",
          stored: true,
        }))
      : [{ id: nextRowId++, key: "", value: "", stored: false }],
  );
  const [error, setError] = useState("");
  const pending = createAccount.isPending || updateAccount.isPending;

  // Providers of the workspace's runtimes; Qoder agents carry no env.
  const providers = useMemo(() => {
    const set = new Set(
      runtimes
        .map((runtime) => runtime.provider)
        .filter((p) => p && p !== "qoder_cloud"),
    );
    if (account?.provider) set.add(account.provider);
    return [...set].sort();
  }, [account?.provider, runtimes]);

  const updateRow = (id: number, patch: Partial<EnvRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !provider) {
      setError(t(($) => $.agent_accounts.required_error));
      return;
    }
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      if (key in env) {
        setError(t(($) => $.agent_accounts.duplicate_key_error, { key }));
        return;
      }
      if (!row.stored && row.value === "") {
        setError(t(($) => $.agent_accounts.value_required_error, { key }));
        return;
      }
      env[key] = row.stored && row.value === "" ? KEEP_VALUE : row.value;
    }

    setError("");
    try {
      if (account) {
        await updateAccount.mutateAsync({
          id: account.id,
          name: trimmedName,
          provider,
          env,
        });
      } else {
        await createAccount.mutateAsync({ name: trimmedName, provider, env });
      }
      toast.success(t(($) => $.agent_accounts.saved_toast));
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.agent_accounts.save_failed_toast),
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {account
              ? t(($) => $.agent_accounts.edit_title)
              : t(($) => $.agent_accounts.create_title)}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="agent-account-name">
              {t(($) => $.agent_accounts.name_label)}
            </Label>
            <Input
              id="agent-account-name"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t(($) => $.agent_accounts.name_placeholder)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t(($) => $.agent_accounts.provider_label)}</Label>
            <Select
              items={providers.map((p) => ({
                value: p,
                label: providerDisplayName(p),
              }))}
              value={provider || null}
              onValueChange={(next) => setProvider(next ?? "")}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label={t(($) => $.agent_accounts.provider_label)}
              >
                <SelectValue
                  placeholder={t(($) => $.agent_accounts.provider_placeholder)}
                >
                  {provider ? providerDisplayName(provider) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>
                    {providerDisplayName(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t(($) => $.agent_accounts.env_label)}</Label>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    { id: nextRowId++, key: "", value: "", stored: false },
                  ])
                }
              >
                <Plus className="h-3 w-3" />
                {t(($) => $.agent_accounts.add_variable)}
              </Button>
            </div>
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    // A stored key is renamed by removing it and adding a new
                    // one: the keep-value marker only applies to the same key.
                    readOnly={row.stored}
                    onChange={(event) => updateRow(row.id, { key: event.target.value })}
                    // eslint-disable-next-line no-restricted-syntax -- env var name placeholder is a technical token, not copy
                    placeholder="KEY"
                    aria-label={t(($) => $.agent_accounts.key_aria)}
                    className="w-[40%] font-mono text-caption"
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={row.value}
                    onChange={(event) => updateRow(row.id, { value: event.target.value })}
                    placeholder={
                      row.stored
                        ? t(($) => $.agent_accounts.value_unchanged_placeholder)
                        : t(($) => $.agent_accounts.value_placeholder)
                    }
                    aria-label={t(($) => $.agent_accounts.value_aria, {
                      key: row.key || "KEY",
                    })}
                    className="flex-1 font-mono text-caption"
                  />
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    label={t(($) => $.agent_accounts.remove_variable_aria)}
                    onClick={() =>
                      setRows((prev) => prev.filter((r) => r.id !== row.id))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-caption text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" disabled={pending} />}
            >
              {t(($) => $.agent_accounts.cancel)}
            </DialogClose>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t(($) => $.agent_accounts.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
