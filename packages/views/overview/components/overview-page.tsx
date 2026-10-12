"use client";

import { useState } from "react";
import { Activity, MessageSquare, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { useOverviewLayoutStore } from "@multica/core/overview";
import type { WorkspaceActivityIssueRef } from "@multica/core/types";
import { CollectionPageHeader, CollectionPageHeaderAction } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { ALL_PROJECTS } from "../../dashboard/components/dashboard-shared";
import { ProjectFilter } from "../../dashboard/components/dashboard-filters";
import { useT } from "../../i18n";
import { StatusChangesFeed, type FeedFocus } from "./activity-feed";
import { cn } from "@multica/ui/lib/utils";

export function OverviewPage() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const [projectValue, setProjectValue] = useState<string>(ALL_PROJECTS);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  // A project that no longer resolves (deleted, or a stale id) counts as no
  // filter, so the trigger cannot claim a filter the feed does not apply.
  const projectId =
    projectValue !== ALL_PROJECTS && projects.some((p) => p.id === projectValue) ? projectValue : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.title)}
        actions={
          <>
            <ProjectFilter projects={projects} projectValue={projectValue} onProjectChange={setProjectValue} />
            <CommentsToggle />
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("flex min-h-full flex-col py-6", PAGE_GUTTER)}>
          <ActivityList
            // A new project starts from a clean slate: an issue filter from
            // another project would leave the feed empty.
            key={projectId ?? ALL_PROJECTS}
            projectId={projectId}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The status-change feed, narrowed to the header's project. Hovering a row
 * tints the issue's other rows, and an optional issue filter is cleared from
 * the chip above.
 */
function ActivityList({ projectId }: { projectId: string | null }) {
  const { t } = useT("overview");
  const [hoveredIssueId, setHoveredIssueId] = useState<string | null>(null);
  const [issue, setIssue] = useState<WorkspaceActivityIssueRef | null>(null);
  const focus: FeedFocus = {
    hoveredIssueId,
    onHoverIssue: setHoveredIssueId,
    issue,
    onFilterIssue: setIssue,
    projectId,
  };

  return (
    // Fills the page height (at least 30rem), so the list reaches the bottom
    // of the window and scrolls inside.
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
      <div className="flex flex-col md:min-h-0 md:flex-1">
        <StatusChangesFeed focus={focus} />
      </div>
    </div>
  );
}

/** Mixes comments into the feed's All tab; remembered per device. */
function CommentsToggle() {
  const { t } = useT("overview");
  const showComments = useOverviewLayoutStore((s) => s.showComments);
  const toggleComments = useOverviewLayoutStore((s) => s.toggleComments);
  return (
    <CollectionPageHeaderAction
      icon={MessageSquare}
      label={t(($) => $.show_comments)}
      variant={showComments ? "brand" : "outline"}
      aria-pressed={showComments}
      onClick={toggleComments}
    />
  );
}
