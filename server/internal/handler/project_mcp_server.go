package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxProjectMcpServersPerRequest = 100

// AddProjectMcpServersRequest attaches workspace MCP library entries to a
// project.
type AddProjectMcpServersRequest struct {
	ServerIDs []string `json:"server_ids"`
}

// ListProjectMcpServers returns the MCP servers attached to a project as the
// same secret-free inventory the workspace library uses: configs carry
// credentials and never leave the server.
func (h *Handler) ListProjectMcpServers(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	h.writeProjectMcpServers(w, r, project)
}

func (h *Handler) writeProjectMcpServers(w http.ResponseWriter, r *http.Request, project db.Project) {
	servers, err := h.Queries.ListProjectMcpServers(r.Context(), db.ListProjectMcpServersParams{
		ProjectID:   project.ID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project MCP servers")
		return
	}
	resp := make([]WorkspaceMcpServerResponse, len(servers))
	for i, server := range servers {
		resp[i] = workspaceMcpServerToResponse(server)
	}
	writeJSON(w, http.StatusOK, resp)
}

// AddProjectMcpServers attaches library entries to a project and returns the
// project's updated list. Attaching an attached server is a no-op.
func (h *Handler) AddProjectMcpServers(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !h.canManageProjectRunConfig(w, r, project) {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req AddProjectMcpServersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.ServerIDs) == 0 {
		writeError(w, http.StatusBadRequest, "server_ids is required")
		return
	}
	if len(req.ServerIDs) > maxProjectMcpServersPerRequest {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("server_ids accepts at most %d ids", maxProjectMcpServersPerRequest))
		return
	}
	serverUUIDs, ok := parseUUIDSliceOrBadRequest(w, req.ServerIDs, "server_ids")
	if !ok {
		return
	}
	// De-duplicate and lock in id order so two attaches cannot deadlock.
	sort.Slice(serverUUIDs, func(i, j int) bool { return bytes.Compare(serverUUIDs[i].Bytes[:], serverUUIDs[j].Bytes[:]) < 0 })
	unique := make([]pgtype.UUID, 0, len(serverUUIDs))
	for i, id := range serverUUIDs {
		if i > 0 && id.Bytes == serverUUIDs[i-1].Bytes {
			continue
		}
		unique = append(unique, id)
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if _, err := qtx.LockProjectForAttach(r.Context(), db.LockProjectForAttachParams{
		ID:          project.ID,
		WorkspaceID: project.WorkspaceID,
	}); err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load project")
		return
	}
	creator, _ := h.parseUserUUIDOrZero(userID)
	added := make([]string, 0, len(unique))
	for _, serverID := range unique {
		// Workspace-scoped, and FOR SHARE serializes this insert against
		// DeleteWorkspaceMcpServer's FOR UPDATE + sweep.
		if _, err := qtx.LockWorkspaceMcpServerForShare(r.Context(), db.LockWorkspaceMcpServerForShareParams{
			ID:          serverID,
			WorkspaceID: project.WorkspaceID,
		}); err != nil {
			if isNotFound(err) {
				writeError(w, http.StatusNotFound, "MCP server not found in this workspace")
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to load MCP server")
			return
		}
		rows, err := qtx.AddProjectMcpServer(r.Context(), db.AddProjectMcpServerParams{
			ProjectID:   project.ID,
			ServerID:    serverID,
			WorkspaceID: project.WorkspaceID,
			CreatedBy:   creator,
		})
		if err != nil {
			slog.Warn("add project mcp server failed", append(logger.RequestAttrs(r), "error", err, "project_id", uuidToString(project.ID))...)
			writeError(w, http.StatusInternalServerError, "failed to add the MCP server")
			return
		}
		if rows > 0 {
			added = append(added, uuidToString(serverID))
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}

	if len(added) > 0 {
		slog.Info("project mcp servers attached", append(logger.RequestAttrs(r),
			"project_id", uuidToString(project.ID), "server_ids", added)...)
		h.publish(
			protocol.EventProjectMcpServerCreated,
			uuidToString(project.WorkspaceID),
			"member",
			userID,
			map[string]any{
				"project_id": uuidToString(project.ID),
				"server_ids": added,
			},
		)
	}
	h.writeProjectMcpServers(w, r, project)
}

// RemoveProjectMcpServer detaches an MCP server from a project.
func (h *Handler) RemoveProjectMcpServer(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !h.canManageProjectRunConfig(w, r, project) {
		return
	}
	serverUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "serverId"), "server id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	removed, err := h.Queries.RemoveProjectMcpServer(r.Context(), db.RemoveProjectMcpServerParams{
		ProjectID:   project.ID,
		ServerID:    serverUUID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove the MCP server")
		return
	}
	if removed == 0 {
		writeError(w, http.StatusNotFound, "project MCP server not found")
		return
	}

	slog.Info("project mcp server detached", append(logger.RequestAttrs(r),
		"project_id", uuidToString(project.ID), "server_id", uuidToString(serverUUID))...)
	h.publish(
		protocol.EventProjectMcpServerDeleted,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{
			"project_id": uuidToString(project.ID),
			"server_id":  uuidToString(serverUUID),
		},
	)
	w.WriteHeader(http.StatusNoContent)
}

// claimMcpConfig assembles the MCP config a claimed task runs with.
//
// Layers, lowest first: the workspace servers bound to the agent and the
// servers attached to the task's project (both library entries, so a shared
// name is the same server), then the agent's own mcp_config, then the per-task
// overlay. A project server the agent has bound but disabled is left out.
//
// Every read is read on every claim, so an admin's edit or a toggle lands on
// the agent's next task with nothing to restart. Errors — including a failed
// read — never fail the claim and never take away what the agent runs with
// today: a broken shared entry falls back to the layers below it.
func (h *Handler) claimMcpConfig(ctx context.Context, task *db.AgentTaskQueue, agent db.Agent, project service.SkillProjectScope, composioMCPEnabled bool) json.RawMessage {
	var mcpConfig json.RawMessage
	if agent.McpConfig != nil {
		mcpConfig = json.RawMessage(agent.McpConfig)
	}

	var bindings []WorkspaceMcpBinding
	seen := map[string]struct{}{}
	add := func(name string, config []byte) {
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		bindings = append(bindings, WorkspaceMcpBinding{Name: name, Config: json.RawMessage(config)})
	}
	// Only bound AND enabled servers are read (GH #6062), so a workspace
	// library entry nobody added reaches nothing.
	if bound, err := h.Queries.ListEnabledAgentMcpServers(ctx, agent.ID); err != nil {
		slog.Warn("daemon claim: load agent mcp servers failed; using agent mcp_config",
			"task_id", uuidToString(task.ID), "agent_id", uuidToString(agent.ID), "error", err)
	} else {
		for _, server := range bound {
			add(server.Name, server.Config)
		}
	}
	if project.ProjectID.Valid {
		if attached, err := h.Queries.ListProjectMcpServersForAgent(ctx, db.ListProjectMcpServersForAgentParams{
			ProjectID:   project.ProjectID,
			WorkspaceID: project.WorkspaceID,
			AgentID:     agent.ID,
		}); err != nil {
			slog.Warn("daemon claim: load project mcp servers failed; continuing without them",
				"task_id", uuidToString(task.ID), "project_id", uuidToString(project.ProjectID), "error", err)
		} else {
			for _, server := range attached {
				add(server.Name, server.Config)
			}
		}
	}
	if len(bindings) > 0 {
		if resolved, err := ResolveAgentMcpConfig(bindings, mcpConfig); err != nil {
			slog.Warn("daemon claim: resolve agent mcp servers failed; falling back to agent mcp_config",
				"task_id", uuidToString(task.ID), "agent_id", uuidToString(agent.ID), "error", err)
		} else {
			mcpConfig = resolved
		}
	}

	// Layer the per-task overlay (set at enqueue from the initiator user's
	// active integrations — currently Composio) on top. Overlay wins on
	// server-name collisions because it carries the live user-scoped session
	// URL.
	if composioMCPEnabled && len(task.RuntimeMcpOverlay) > 0 {
		if merged, err := mergeMCPOverlay(mcpConfig, json.RawMessage(task.RuntimeMcpOverlay)); err != nil {
			slog.Warn("daemon claim: merge runtime_mcp_overlay failed; falling back to agent mcp_config", "task_id", uuidToString(task.ID), "error", err)
		} else {
			mcpConfig = merged
		}
	}
	return mcpConfig
}
