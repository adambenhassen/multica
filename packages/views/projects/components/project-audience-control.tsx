"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Users } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { labelListOptions } from "@multica/core/labels";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { ProjectAttachmentAudience } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { useT } from "../../i18n";

const EVERYONE: ProjectAttachmentAudience = { restricted: false, agent_ids: [], label_ids: [] };

/**
 * Shows and edits which agents a project skill / MCP server reaches. Members
 * see the summary; owners and admins can open the editor.
 */
export function ProjectAudienceControl({
  audience,
  itemName,
  canManage,
  onSave,
}: {
  /** Absent on servers that predate audiences, which means every agent. */
  audience: ProjectAttachmentAudience | undefined;
  itemName: string;
  canManage: boolean;
  onSave: (audience: ProjectAttachmentAudience) => Promise<void>;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const current = audience ?? EVERYONE;
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: labels = [] } = useQuery(labelListOptions(wsId, "agent"));

  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const labelName = useMemo(() => new Map(labels.map((l) => [l.id, l.name])), [labels]);

  const summary = !current.restricted
    ? t(($) => $.audience.everyone)
    : current.agent_ids.length + current.label_ids.length === 0
      ? t(($) => $.audience.nobody)
      : [
          ...current.agent_ids.map((id) => agentName.get(id) ?? t(($) => $.audience.unknown_agent)),
          ...current.label_ids.map((id) => `#${labelName.get(id) ?? t(($) => $.audience.unknown_label)}`),
        ].join(", ");

  const chip = (
    <span className="inline-flex min-w-0 max-w-40 items-center gap-1 text-caption text-muted-foreground">
      <Users className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{summary}</span>
    </span>
  );

  if (!canManage) {
    return <span title={summary}>{chip}</span>;
  }
  return (
    <AudienceEditor
      current={current}
      itemName={itemName}
      summary={summary}
      chip={chip}
      agents={agents.filter((a) => !a.archived_at)}
      labels={labels}
      onSave={onSave}
    />
  );
}

function AudienceEditor({
  current,
  itemName,
  summary,
  chip,
  agents,
  labels,
  onSave,
}: {
  current: ProjectAttachmentAudience;
  itemName: string;
  summary: string;
  chip: React.ReactNode;
  agents: { id: string; name: string }[];
  labels: { id: string; name: string }[];
  onSave: (audience: ProjectAttachmentAudience) => Promise<void>;
}) {
  const { t } = useT("projects");
  const [open, setOpen] = useState(false);
  const [restricted, setRestricted] = useState(current.restricted);
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set(current.agent_ids));
  const [labelIds, setLabelIds] = useState<Set<string>>(new Set(current.label_ids));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setRestricted(current.restricted);
    setAgentIds(new Set(current.agent_ids));
    setLabelIds(new Set(current.label_ids));
    setQuery("");
  };

  const toggle = (set: Set<string>, id: string, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  const q = query.trim().toLowerCase();
  const visibleAgents = q ? agents.filter((a) => a.name.toLowerCase().includes(q)) : agents;
  const visibleLabels = q ? labels.filter((l) => l.name.toLowerCase().includes(q)) : labels;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(
        restricted
          ? { restricted: true, agent_ids: [...agentIds], label_ids: [...labelIds] }
          : { restricted: false, agent_ids: [], label_ids: [] },
      );
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.audience.save_failed_toast));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (v) reset();
        setOpen(v);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="min-w-0 rounded-sm px-1 hover:bg-accent"
            aria-label={t(($) => $.audience.edit_aria, { name: itemName, audience: summary })}
          />
        }
      >
        {chip}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        <label className="flex items-center gap-2 text-caption">
          <Checkbox checked={restricted} onCheckedChange={(v) => setRestricted(v === true)} />
          {t(($) => $.audience.restrict_label)}
        </label>
        {restricted && (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t(($) => $.audience.search_placeholder)}
                placeholder={t(($) => $.audience.search_placeholder)}
                className="h-8 w-full rounded-md border bg-transparent pl-7 pr-2 text-caption outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {visibleLabels.length > 0 && (
                <p className="px-1 pt-1 text-micro font-medium text-muted-foreground">
                  {t(($) => $.audience.labels_heading)}
                </p>
              )}
              {visibleLabels.map((l) => (
                <label key={l.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-caption hover:bg-accent">
                  <Checkbox checked={labelIds.has(l.id)} onCheckedChange={() => toggle(labelIds, l.id, setLabelIds)} />
                  <span className="truncate">#{l.name}</span>
                </label>
              ))}
              <p className="px-1 pt-1 text-micro font-medium text-muted-foreground">
                {t(($) => $.audience.agents_heading)}
              </p>
              {visibleAgents.map((a) => (
                <label key={a.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-caption hover:bg-accent">
                  <Checkbox checked={agentIds.has(a.id)} onCheckedChange={() => toggle(agentIds, a.id, setAgentIds)} />
                  <span className="truncate">{a.name}</span>
                </label>
              ))}
            </div>
            {agentIds.size + labelIds.size === 0 && (
              <p className="text-caption text-muted-foreground">{t(($) => $.audience.nobody_hint)}</p>
            )}
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t(($) => $.audience.cancel)}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} aria-busy={saving}>
            {t(($) => $.audience.save)}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
