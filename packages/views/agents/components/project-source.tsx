"use client";

import type { ReactNode } from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import type { ProjectRef } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

/**
 * Marks an item the agent has directly that one or more projects also give it
 * (in tasks of those projects).
 */
export function ProjectSourceBadge({ projects }: { projects: ProjectRef[] | undefined }) {
  const { t } = useT("agents");
  if (!projects || projects.length === 0) return null;
  const titles = projects.map((p) => p.title).join(", ");
  return (
    <Badge variant="secondary" className="max-w-48 truncate" title={titles}>
      {projects.length === 1
        ? t(($) => $.project_source.also_via_project, { project: projects[0]!.title })
        : t(($) => $.project_source.also_via_many, { count: projects.length })}
    </Badge>
  );
}

/**
 * Read-only list of items the agent receives only from projects. They are
 * managed on each project's page.
 */
export function ProjectSourceList({
  title,
  hint,
  icon,
  items,
}: {
  title: string;
  hint: string;
  icon: ReactNode;
  items: { id: string; name: string; detail: string; projects: ProjectRef[] }[];
}) {
  const wsPaths = useWorkspacePaths();
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-body font-medium">{title}</h3>
        <p className="text-caption text-muted-foreground">{hint}</p>
      </div>
      <ul className="divide-y rounded-lg border bg-surface-raised/40">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">{item.name}</span>
              <span className="block truncate text-caption text-muted-foreground">{item.detail}</span>
            </span>
            <span className="flex max-w-56 flex-wrap justify-end gap-1">
              {item.projects.map((p) => (
                <AppLink
                  key={p.id}
                  href={wsPaths.projectDetail(p.id)}
                  className="rounded-sm text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {p.title}
                </AppLink>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
