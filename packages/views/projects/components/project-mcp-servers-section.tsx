"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  projectMcpServersOptions,
  useAddProjectMcpServers,
  useRemoveProjectMcpServer,
  useSetProjectMcpServerAudience,
} from "@multica/core/projects";
import { useWorkspaceId } from "@multica/core/hooks";
import { workspaceMcpServersOptions } from "@multica/core/workspace/queries";
import type { ProjectMcpServer, WorkspaceMcpServer } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { mcpTransportLabel } from "../../common/mcp-transport";
import { ProjectAudienceControl } from "./project-audience-control";
import { useT } from "../../i18n";

// Stable fallback: a fresh `[]` default per render would re-run the memo below.
const NO_SERVERS: WorkspaceMcpServer[] = [];
const NO_PROJECT_SERVERS: ProjectMcpServer[] = [];

export function ProjectMcpServersSection({
  projectId,
  canManage,
}: {
  projectId: string;
  /** Workspace owners and admins attach and detach project MCP servers. */
  canManage: boolean;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(true);

  const { data: servers = NO_PROJECT_SERVERS } = useQuery(projectMcpServersOptions(wsId, projectId));
  const removeServer = useRemoveProjectMcpServer(wsId, projectId);
  const setAudience = useSetProjectMcpServerAudience(wsId, projectId);

  const handleRemove = async (server: WorkspaceMcpServer) => {
    try {
      await removeServer.mutateAsync(server.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.mcp.remove_failed_toast));
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {t(($) => $.mcp.section_header)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2 space-y-1.5">
          {servers.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.mcp.empty)}</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="group flex items-center gap-2 text-caption text-muted-foreground"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{server.name}</span>
                  <span className="shrink-0">{mcpTransportLabel(server.transport)}</span>
                  <ProjectAudienceControl
                    audience={server.audience}
                    itemName={server.name}
                    canManage={canManage}
                    onSave={(audience) => setAudience.mutateAsync({ serverId: server.id, audience })}
                  />
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleRemove(server)}
                      disabled={removeServer.isPending && removeServer.variables === server.id}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded-sm p-0.5 hover:bg-accent"
                      aria-label={t(($) => $.mcp.remove_aria, { name: server.name })}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && <ProjectMcpServerPicker projectId={projectId} attached={servers} />}
          <p className="text-caption text-muted-foreground">{t(($) => $.mcp.hint)}</p>
        </div>
      )}
    </div>
  );
}

/** Attaches one workspace library entry per pick, like the agent MCP tab. */
function ProjectMcpServerPicker({
  projectId,
  attached,
}: {
  projectId: string;
  attached: readonly WorkspaceMcpServer[];
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: library = NO_SERVERS } = useQuery(workspaceMcpServersOptions(wsId));
  const addServers = useAddProjectMcpServers(wsId, projectId);

  const available = useMemo(() => {
    const attachedIds = new Set(attached.map((s) => s.id));
    return library.filter((s) => !attachedIds.has(s.id));
  }, [library, attached]);

  const handleSelect = async (serverId: string) => {
    try {
      await addServers.mutateAsync([serverId]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.mcp.add_failed_toast));
    }
  };

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-caption text-muted-foreground hover:text-foreground"
      disabled={available.length === 0 || addServers.isPending}
      aria-busy={addServers.isPending}
    >
      <Plus className="size-3" />
      {t(($) => $.mcp.add_button)}
    </Button>
  );

  if (available.length === 0) {
    return (
      <div className="space-y-1">
        {trigger}
        <p className="text-caption text-muted-foreground">
          {library.length === 0 ? t(($) => $.mcp.add_empty) : t(($) => $.mcp.add_empty_partial)}
        </p>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-(--anchor-width) max-w-[min(20rem,var(--available-width))]"
      >
        {available.map((server) => (
          <DropdownMenuItem key={server.id} className="gap-3" onClick={() => handleSelect(server.id)}>
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <span className="shrink-0 text-caption text-muted-foreground">
              {mcpTransportLabel(server.transport)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
