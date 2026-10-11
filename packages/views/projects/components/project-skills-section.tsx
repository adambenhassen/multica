"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  projectSkillsOptions,
  useAddProjectSkills,
  useRemoveProjectSkill,
} from "@multica/core/projects";
import { useWorkspaceId } from "@multica/core/hooks";
import { skillListOptions } from "@multica/core/workspace/queries";
import type { SkillSummary } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { SkillPickerList } from "../../agents/components/skill-picker-list";
import { SkillIcon } from "../../skills/lib/skill-icon";
import { useT } from "../../i18n";

export function ProjectSkillsSection({
  projectId,
  canManage,
}: {
  projectId: string;
  /** Workspace owners and admins attach and detach project skills. */
  canManage: boolean;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(true);

  const { data: skills = [] } = useQuery(projectSkillsOptions(wsId, projectId));
  const removeSkill = useRemoveProjectSkill(wsId, projectId);

  const handleRemove = async (skill: SkillSummary) => {
    try {
      await removeSkill.mutateAsync(skill.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.skills.remove_failed_toast));
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.skills.section_header)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2 space-y-1.5">
          {skills.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.skills.empty)}</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="group flex items-center gap-2 text-caption text-muted-foreground"
                >
                  <SkillIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{skill.name}</span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleRemove(skill)}
                      disabled={removeSkill.isPending && removeSkill.variables === skill.id}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
                      aria-label={t(($) => $.skills.remove_aria, { name: skill.name })}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && <ProjectSkillAddDialog projectId={projectId} attached={skills} />}
          <p className="text-caption text-muted-foreground">{t(($) => $.skills.hint)}</p>
        </div>
      )}
    </div>
  );
}

function ProjectSkillAddDialog({
  projectId,
  attached,
}: {
  projectId: string;
  attached: readonly SkillSummary[];
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: workspaceSkills = [], isLoading } = useQuery(skillListOptions(wsId));
  const addSkills = useAddProjectSkills(wsId, projectId);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const availableSkills = useMemo(() => {
    const attachedIds = new Set(attached.map((s) => s.id));
    return workspaceSkills.filter((s) => !attachedIds.has(s.id));
  }, [workspaceSkills, attached]);

  const handleOpenChange = (v: boolean) => {
    if (!v) setSelectedIds(new Set());
    setOpen(v);
  };

  const handleToggle = (skill: SkillSummary) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selectedIds.size === 0) return;
    try {
      await addSkills.mutateAsync([...selectedIds]);
      handleOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.skills.add_failed_toast));
    }
  };

  const count = selectedIds.size;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-caption text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Plus className="size-3" />
        {t(($) => $.skills.add_button)}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-body">{t(($) => $.skills.add_dialog_title)}</DialogTitle>
        </DialogHeader>

        <SkillPickerList
          skills={availableSkills}
          selectedIds={selectedIds}
          onToggle={handleToggle}
          loading={isLoading}
          emptyMessage={
            workspaceSkills.length === 0
              ? t(($) => $.skills.add_dialog_empty)
              : t(($) => $.skills.add_dialog_empty_partial)
          }
        />

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(($) => $.skills.add_dialog_cancel)}
          </DialogClose>
          <Button
            onClick={handleConfirm}
            disabled={count === 0 || addSkills.isPending}
            aria-busy={addSkills.isPending}
          >
            {addSkills.isPending
              ? t(($) => $.skills.add_dialog_saving)
              : count > 0
                ? t(($) => $.skills.add_dialog_confirm, { count })
                : t(($) => $.skills.add_dialog_confirm_default)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
