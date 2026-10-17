"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { agentFallbacksOptions, useReplaceAgentFallbacks } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { isRuntimeUsableForUser } from "@multica/core/runtimes";
import type { Agent, AgentModelFallback, AgentRuntime, MemberWithUser } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../../../settings/components/settings-layout";
import { useT } from "../../../i18n";
import { ModelPicker } from "./model-picker";
import { RuntimePicker } from "./runtime-picker";
import { ThinkingSettingField } from "./thinking-prop-row";

const MAX_FALLBACKS = 4;

type Entry = Pick<AgentModelFallback, "runtime_id" | "model" | "thinking_level">;

/**
 * Ordered fallback (runtime, model) pairs for an agent. Every edit saves the
 * whole list, so editing is blocked until the saved list has loaded: a failed
 * load must never be mistaken for an empty list and overwrite it. An entry's
 * runtime is fixed once saved (its model and effort belong to that runtime);
 * remove and re-add to change it. A new entry stays local until it has a
 * model, because the server rejects an empty one.
 */
export function FallbacksSection({
  agent,
  runtimes,
  members,
  currentUserId,
  canEdit,
}: {
  agent: Agent;
  runtimes: AgentRuntime[];
  members: MemberWithUser[];
  currentUserId: string | null;
  canEdit: boolean;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const query = useQuery(agentFallbacksOptions(wsId, agent.id));
  const replace = useReplaceAgentFallbacks(wsId, agent.id);
  const [draft, setDraft] = useState<Entry | null>(null);

  const editable = canEdit && query.isSuccess;
  // Every save sends the whole list: hold further edits until it settles so a
  // second save is never computed from the pre-save list.
  const interactive = editable && !replace.isPending;
  const entries: Entry[] = (query.data ?? []).map(({ runtime_id, model, thinking_level }) => ({
    runtime_id,
    model,
    thinking_level,
  }));

  const save = async (next: Entry[]): Promise<boolean> => {
    try {
      await replace.mutateAsync({ fallbacks: next });
      return true;
    } catch (e) {
      toast.error(t(($) => $.fallbacks.save_failed), {
        description: e instanceof Error ? e.message : undefined,
      });
      return false;
    }
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...entries];
    const [entry] = next.splice(index, 1);
    next.splice(index + delta, 0, entry!);
    void save(next);
  };
  const runtimeFor = (id: string) => runtimes.find((r) => r.id === id) ?? null;
  const canDiscover = (id: string) => {
    const runtime = runtimeFor(id);
    return runtime?.status === "online" && isRuntimeUsableForUser(runtime, currentUserId);
  };
  const full = entries.length + (draft ? 1 : 0) >= MAX_FALLBACKS;

  return (
    <SettingsSection
      title={t(($) => $.fallbacks.title)}
      description={t(($) => $.fallbacks.description)}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={!interactive || full}
          onClick={() => setDraft({ runtime_id: agent.runtime_id, model: "", thinking_level: "" })}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t(($) => $.fallbacks.add)}
        </Button>
      }
    >
      {query.isError ? (
        <div className="flex items-center justify-between gap-2 text-sm text-destructive">
          {t(($) => $.fallbacks.load_failed)}
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t(($) => $.fallbacks.retry)}
          </Button>
        </div>
      ) : null}
      {entries.map((entry, index) => (
        <SettingsCard key={`${entry.runtime_id}:${entry.model}`}>
          <SettingsRow label={t(($) => $.fallbacks.entry, { n: index + 1 })} size="select-wide">
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.fallbacks.move_up)}
                disabled={!interactive || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.fallbacks.move_down)}
                disabled={!interactive || index === entries.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.fallbacks.remove)}
                disabled={!interactive}
                onClick={() => void save(entries.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label={t(($) => $.inspector.prop_runtime)} size="select-wide">
            <RuntimePicker
              variant="field"
              showLabel={false}
              value={entry.runtime_id}
              runtimes={runtimes}
              members={members}
              currentUserId={currentUserId}
              canEdit={false}
              onChange={() => {}}
            />
          </SettingsRow>
          <SettingsRow label={t(($) => $.inspector.prop_model)} size="select-wide">
            <ModelPicker
              variant="field"
              showLabel={false}
              runtimeId={entry.runtime_id}
              runtimeOnline={canDiscover(entry.runtime_id)}
              value={entry.model}
              canEdit={interactive}
              onChange={(model) =>
                model
                  ? void save(entries.map((e, i) => (i === index ? { ...e, model, thinking_level: "" } : e)))
                  : undefined
              }
            />
          </SettingsRow>
          <ThinkingSettingField
            label={t(($) => $.inspector.prop_thinking)}
            runtimeId={entry.runtime_id}
            runtimeOnline={canDiscover(entry.runtime_id)}
            provider={runtimeFor(entry.runtime_id)?.provider ?? ""}
            model={entry.model}
            value={entry.thinking_level}
            canEdit={interactive}
            onChange={(thinking_level) =>
              void save(entries.map((e, i) => (i === index ? { ...e, thinking_level } : e)))
            }
          />
        </SettingsCard>
      ))}
      {draft ? (
        <SettingsCard>
          <SettingsRow label={t(($) => $.fallbacks.entry, { n: entries.length + 1 })} size="select-wide">
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                {t(($) => $.fallbacks.cancel)}
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label={t(($) => $.inspector.prop_runtime)} size="select-wide">
            <RuntimePicker
              variant="field"
              showLabel={false}
              value={draft.runtime_id}
              runtimes={runtimes}
              members={members}
              currentUserId={currentUserId}
              canEdit={interactive}
              onChange={(runtime_id) => setDraft({ runtime_id, model: "", thinking_level: "" })}
            />
          </SettingsRow>
          <SettingsRow label={t(($) => $.inspector.prop_model)} size="select-wide">
            <ModelPicker
              variant="field"
              showLabel={false}
              runtimeId={draft.runtime_id}
              runtimeOnline={canDiscover(draft.runtime_id)}
              value={draft.model}
              canEdit={interactive}
              onChange={async (model) => {
                if (!model) return;
                if (await save([...entries, { ...draft, model }])) setDraft(null);
              }}
            />
          </SettingsRow>
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
