"use client";

import { useState } from "react";
import { Activity, SlidersHorizontal, Tag, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useDefaultLayout } from "react-resizable-panels";
import { Button } from "@multica/ui/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@multica/ui/components/ui/resizable";
import { useIsMobile } from "@multica/ui/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { OVERVIEW_SECTIONS, useOverviewLayoutStore, type OverviewSection } from "@multica/core/overview";
import type { WorkspaceActivityIssueRef } from "@multica/core/types";
import { CollectionPageHeader, CollectionPageHeaderAction } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { ALL_PROJECTS } from "../../dashboard/components/dashboard-shared";
import { ProjectFilter } from "../../dashboard/components/dashboard-filters";
import { useT } from "../../i18n";
import { ActivityFeed, StatusChangesFeed, type FeedFocus } from "./activity-feed";
import { cn } from "@multica/ui/lib/utils";

export function OverviewPage() {
  const { t } = useT("overview");
  const hidden = useOverviewLayoutStore((s) => s.hidden);
  const showAll = useOverviewLayoutStore((s) => s.showAll);
  // Hidden sections are not rendered at all, so they also stop fetching.
  const shown = (section: OverviewSection) => !hidden.includes(section);
  const listCount = Number(shown("activity")) + Number(shown("status_changes"));

  const wsId = useWorkspaceId();
  const [projectValue, setProjectValue] = useState<string>(ALL_PROJECTS);
  const { data: projects = [] } = useQuery({ ...projectListOptions(wsId), enabled: listCount > 0 });
  // A project that no longer resolves (deleted, or a stale id) counts as no
  // filter, so the trigger cannot claim a filter the feeds do not apply.
  const projectId =
    projectValue !== ALL_PROJECTS && projects.some((p) => p.id === projectValue) ? projectValue : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.title)}
        actions={
          <>
            {listCount > 0 && (
              <>
                <ProjectFilter projects={projects} projectValue={projectValue} onProjectChange={setProjectValue} />
                <ProjectLabelsToggle />
              </>
            )}
            <CustomizeMenu />
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("flex min-h-full flex-col gap-6 py-6", PAGE_GUTTER)}>
          {OVERVIEW_SECTIONS.every((section) => !shown(section)) && (
            <div className="flex items-center justify-between gap-2 rounded-lg border p-4 text-label text-muted-foreground">
              <span>{t(($) => $.customize.all_hidden)}</span>
              <Button variant="ghost" size="sm" onClick={showAll}>
                {t(($) => $.customize.show_all)}
              </Button>
            </div>
          )}
          {listCount > 0 && (
            <FeedLists
              // A new project starts from a clean slate: an issue filter from
              // another project would leave both feeds empty.
              key={projectId ?? ALL_PROJECTS}
              projectId={projectId}
              showActivity={shown("activity")}
              showStatusChanges={shown("status_changes")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The two feeds side by side (resizable on desktop, stacked on phones),
 * narrowed to the header's project. They share
 * the hovered issue (its rows are tinted in both) and an optional issue
 * filter, cleared from the chip above.
 */
function FeedLists({
  projectId,
  showActivity,
  showStatusChanges,
}: {
  projectId: string | null;
  showActivity: boolean;
  showStatusChanges: boolean;
}) {
  const { t } = useT("overview");
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null);
  const [issue, setIssue] = useState<WorkspaceActivityIssueRef | null>(null);
  const isMobile = useIsMobile();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "multica_activity_split" });
  const focus: FeedFocus = {
    hoveredIssueId,
    onHoverIssue: setHoveredIssueId,
    issue,
    onFilterIssue: setIssue,
    projectId,
  };

  return (
    // Takes the height left below the other sections (at least 30rem), so the
    // lists reach the bottom of the window however many sections are hidden.
    <div className="flex flex-col gap-3 md:min-h-[30rem] md:flex-1 md:basis-0">
      {issue && (
        <div className="flex min-w-0 items-center gap-2 text-label">
          <span className="shrink-0 text-muted-foreground">{t(($) => $.issue_filter.label)}</span>
          <span className="flex min-w-0 items-center gap-1.5 rounded-md border bg-card py-0.5 pr-0.5 pl-2">
            <span className="shrink-0 font-mono text-caption text-muted-foreground">{issue.identifier}</span>
            <span className="min-w-0 truncate" title={issue.title}>
              {issue.title}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t(($) => $.issue_filter.clear)}
              title={t(($) => $.issue_filter.clear)}
              onClick={() => setIssue(null)}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        </div>
      )}
      {showActivity && showStatusChanges && !isMobile ? (
        // Side by side, the split between the feeds drags either way and is
        // remembered per device. Each keeps room for its tabs and a readable
        // row (title, ID, time).
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <ResizablePanel id="activity" minSize="22rem" className="flex min-h-0 min-w-0 flex-col">
            <ActivityFeed focus={focus} />
          </ResizablePanel>
          <ResizableHandle withHandle className="mx-2" />
          <ResizablePanel id="status_changes" minSize="22rem" className="flex min-h-0 min-w-0 flex-col">
            <StatusChangesFeed focus={focus} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-col gap-4 md:min-h-0 md:flex-1 md:flex-row">
          {showActivity && <ActivityFeed focus={focus} />}
          {showStatusChanges && <StatusChangesFeed focus={focus} />}
        </div>
      )}
    </div>
  );
}

function ProjectLabelsToggle() {
  const { t } = useT("overview");
  const showProjects = useOverviewLayoutStore((s) => s.showProjects);
  const toggleProjects = useOverviewLayoutStore((s) => s.toggleProjects);
  return (
    <CollectionPageHeaderAction
      icon={Tag}
      label={t(($) => $.project_labels)}
      variant={showProjects ? "brand" : "outline"}
      aria-pressed={showProjects}
      onClick={toggleProjects}
    />
  );
}

function CustomizeMenu() {
  const { t } = useT("overview");
  const hidden = useOverviewLayoutStore((s) => s.hidden);
  const toggleSection = useOverviewLayoutStore((s) => s.toggleSection);
  const showAll = useOverviewLayoutStore((s) => s.showAll);
  const sectionLabels: Record<OverviewSection, string> = {
    activity: t(($) => $.activity.heading),
    status_changes: t(($) => $.status_changes.heading),
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <CollectionPageHeaderAction icon={SlidersHorizontal} label={t(($) => $.customize.button)} />
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t(($) => $.customize.label)}</DropdownMenuLabel>
          {OVERVIEW_SECTIONS.map((section) => (
            <DropdownMenuCheckboxItem
              key={section}
              checked={!hidden.includes(section)}
              onCheckedChange={() => toggleSection(section)}
            >
              {sectionLabels[section]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {hidden.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={showAll}>{t(($) => $.customize.show_all)}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
