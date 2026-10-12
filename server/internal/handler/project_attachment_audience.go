package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	projectAttachmentSkill     = "skill"
	projectAttachmentMcpServer = "mcp_server"

	maxProjectAttachmentAudienceTargets = 200
)

// ProjectAttachmentAudience says which agents a project skill / MCP server
// link reaches. By default a link reaches every agent in the project. A
// restricted link reaches only the listed agents and agents carrying a listed
// label; with no targets it reaches nobody. An excluded link reaches every
// agent except those; with no targets it reaches everyone. At most one of
// Restricted and Excluded is set.
type ProjectAttachmentAudience struct {
	Restricted bool     `json:"restricted"`
	Excluded   bool     `json:"excluded"`
	AgentIDs   []string `json:"agent_ids"`
	LabelIDs   []string `json:"label_ids"`
}

// ProjectSkillResponse is a project skill with its audience.
type ProjectSkillResponse struct {
	SkillSummaryResponse
	Audience ProjectAttachmentAudience `json:"audience"`
}

// ProjectMcpServerResponse is a project MCP server (secret-free inventory)
// with its audience.
type ProjectMcpServerResponse struct {
	WorkspaceMcpServerResponse
	Audience ProjectAttachmentAudience `json:"audience"`
}

// SetProjectAttachmentAudienceRequest replaces one link's audience. Clients
// that predate exclusions omit Excluded, which reads as false.
type SetProjectAttachmentAudienceRequest struct {
	Restricted bool     `json:"restricted"`
	Excluded   bool     `json:"excluded"`
	AgentIDs   []string `json:"agent_ids"`
	LabelIDs   []string `json:"label_ids"`
}

func projectAttachmentKey(itemType string, itemID pgtype.UUID) string {
	return itemType + ":" + uuidToString(itemID)
}

// loadProjectAudienceTargets returns every audience target of the project's
// links, keyed by projectAttachmentKey. Restricted flags live on the links.
func (h *Handler) loadProjectAudienceTargets(ctx context.Context, project db.Project) (map[string]ProjectAttachmentAudience, error) {
	rows, err := h.Queries.ListProjectAttachmentAudience(ctx, db.ListProjectAttachmentAudienceParams{
		ProjectID:   project.ID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		return nil, err
	}
	out := make(map[string]ProjectAttachmentAudience)
	for _, row := range rows {
		key := projectAttachmentKey(row.ItemType, row.ItemID)
		a := out[key]
		switch row.TargetType {
		case "agent":
			a.AgentIDs = append(a.AgentIDs, uuidToString(row.TargetID))
		case "label":
			a.LabelIDs = append(a.LabelIDs, uuidToString(row.TargetID))
		}
		out[key] = a
	}
	return out, nil
}

func audienceFor(targets map[string]ProjectAttachmentAudience, itemType string, itemID pgtype.UUID, restricted, excluded bool) ProjectAttachmentAudience {
	a := targets[projectAttachmentKey(itemType, itemID)]
	a.Restricted = restricted
	a.Excluded = excluded
	if a.AgentIDs == nil {
		a.AgentIDs = []string{}
	}
	if a.LabelIDs == nil {
		a.LabelIDs = []string{}
	}
	return a
}

// SetProjectSkillAudience replaces who a project skill reaches.
func (h *Handler) SetProjectSkillAudience(w http.ResponseWriter, r *http.Request) {
	h.setProjectAttachmentAudience(w, r, projectAttachmentSkill, chi.URLParam(r, "skillId"))
}

// SetProjectMcpServerAudience replaces who a project MCP server reaches.
func (h *Handler) SetProjectMcpServerAudience(w http.ResponseWriter, r *http.Request) {
	h.setProjectAttachmentAudience(w, r, projectAttachmentMcpServer, chi.URLParam(r, "serverId"))
}

func (h *Handler) setProjectAttachmentAudience(w http.ResponseWriter, r *http.Request, itemType, itemParam string) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !h.canManageProjectRunConfig(w, r, project) {
		return
	}
	itemID, ok := parseUUIDOrBadRequest(w, itemParam, "item id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req SetProjectAttachmentAudienceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Restricted && req.Excluded {
		writeError(w, http.StatusBadRequest, "restricted and excluded cannot both be set")
		return
	}
	if !req.Restricted && !req.Excluded && (len(req.AgentIDs) > 0 || len(req.LabelIDs) > 0) {
		writeError(w, http.StatusBadRequest, "agent_ids and label_ids require restricted or excluded")
		return
	}
	if len(req.AgentIDs)+len(req.LabelIDs) > maxProjectAttachmentAudienceTargets {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("an audience accepts at most %d targets", maxProjectAttachmentAudienceTargets))
		return
	}
	agentIDs, ok := parseUUIDSliceOrBadRequest(w, req.AgentIDs, "agent_ids")
	if !ok {
		return
	}
	labelIDs, ok := parseUUIDSliceOrBadRequest(w, req.LabelIDs, "label_ids")
	if !ok {
		return
	}
	agentIDs, labelIDs = uniqueUUIDs(agentIDs), uniqueUUIDs(labelIDs)

	if len(agentIDs) > 0 {
		n, err := h.Queries.CountLiveAgentsInWorkspace(r.Context(), db.CountLiveAgentsInWorkspaceParams{
			AgentIds: agentIDs, WorkspaceID: project.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to validate agents")
			return
		}
		if n != int64(len(agentIDs)) {
			writeError(w, http.StatusNotFound, "agent not found in this workspace")
			return
		}
	}
	if len(labelIDs) > 0 {
		n, err := h.Queries.CountAgentLabelsInWorkspace(r.Context(), db.CountAgentLabelsInWorkspaceParams{
			LabelIds: labelIDs, WorkspaceID: project.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to validate labels")
			return
		}
		if n != int64(len(labelIDs)) {
			writeError(w, http.StatusNotFound, "agent label not found in this workspace")
			return
		}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if _, err := qtx.LockProjectForAttach(r.Context(), db.LockProjectForAttachParams{
		ID: project.ID, WorkspaceID: project.WorkspaceID,
	}); err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load project")
		return
	}

	var updated int64
	switch itemType {
	case projectAttachmentSkill:
		updated, err = qtx.SetProjectSkillAudienceMode(r.Context(), db.SetProjectSkillAudienceModeParams{
			Restricted: req.Restricted, Excluded: req.Excluded,
			ProjectID: project.ID, SkillID: itemID, WorkspaceID: project.WorkspaceID,
		})
	case projectAttachmentMcpServer:
		updated, err = qtx.SetProjectMcpServerAudienceMode(r.Context(), db.SetProjectMcpServerAudienceModeParams{
			Restricted: req.Restricted, Excluded: req.Excluded,
			ProjectID: project.ID, ServerID: itemID, WorkspaceID: project.WorkspaceID,
		})
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update audience")
		return
	}
	if updated == 0 {
		writeError(w, http.StatusNotFound, "not attached to this project")
		return
	}
	if err := qtx.DeleteProjectAttachmentAudience(r.Context(), db.DeleteProjectAttachmentAudienceParams{
		ProjectID: project.ID, ItemType: itemType, ItemID: itemID, WorkspaceID: project.WorkspaceID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update audience")
		return
	}
	add := func(targetType string, ids []pgtype.UUID) error {
		for _, id := range ids {
			if err := qtx.AddProjectAttachmentAudienceTarget(r.Context(), db.AddProjectAttachmentAudienceTargetParams{
				ProjectID: project.ID, ItemType: itemType, ItemID: itemID,
				TargetType: targetType, TargetID: id, WorkspaceID: project.WorkspaceID,
			}); err != nil {
				return err
			}
		}
		return nil
	}
	if err := add("agent", agentIDs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update audience")
		return
	}
	if err := add("label", labelIDs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update audience")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}

	event := protocol.EventProjectSkillUpdated
	if itemType == projectAttachmentMcpServer {
		event = protocol.EventProjectMcpServerUpdated
	}
	h.publish(event, uuidToString(project.WorkspaceID), "member", userID, map[string]any{
		"project_id": uuidToString(project.ID),
		"item_id":    uuidToString(itemID),
	})
	if itemType == projectAttachmentSkill {
		h.writeProjectSkills(w, r, project)
	} else {
		h.writeProjectMcpServers(w, r, project)
	}
}

func uniqueUUIDs(ids []pgtype.UUID) []pgtype.UUID {
	seen := make(map[[16]byte]struct{}, len(ids))
	out := make([]pgtype.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id.Bytes]; ok {
			continue
		}
		seen[id.Bytes] = struct{}{}
		out = append(out, id)
	}
	return out
}

// ProjectRef names a project an agent receives an item from.
type ProjectRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// AgentProjectSkillResponse is a project skill that reaches an agent, with the
// projects it comes from.
type AgentProjectSkillResponse struct {
	SkillSummaryResponse
	Projects []ProjectRef `json:"projects"`
}

// AgentProjectMcpServerResponse is a project MCP server that reaches an agent
// (secret-free inventory), with the projects it comes from.
type AgentProjectMcpServerResponse struct {
	WorkspaceMcpServerResponse
	Projects []ProjectRef `json:"projects"`
}

// ListAgentProjectSkills returns the project skills that reach this agent in
// tasks of each project, per the projects' audiences. Read-only: they are
// managed on the project page.
func (h *Handler) ListAgentProjectSkills(w http.ResponseWriter, r *http.Request) {
	agent, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListAgentProjectSkills(r.Context(), db.ListAgentProjectSkillsParams{
		WorkspaceID: agent.WorkspaceID, AgentID: agent.ID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project skills")
		return
	}
	resp := []AgentProjectSkillResponse{}
	index := map[string]int{}
	for _, row := range rows {
		id := uuidToString(row.ID)
		i, seen := index[id]
		if !seen {
			i = len(resp)
			index[id] = i
			resp = append(resp, AgentProjectSkillResponse{
				SkillSummaryResponse: skillSummaryToResponse(
					row.ID, row.WorkspaceID, row.Name, row.Description, row.Config,
					row.CreatedBy, row.CreatedAt, row.UpdatedAt,
				),
				Projects: []ProjectRef{},
			})
		}
		resp[i].Projects = append(resp[i].Projects, ProjectRef{ID: uuidToString(row.ProjectID), Title: row.ProjectTitle})
	}
	writeJSON(w, http.StatusOK, resp)
}

// ListAgentProjectMcpServers returns the project MCP servers that reach this
// agent, per the projects' audiences. Configs never leave the server.
func (h *Handler) ListAgentProjectMcpServers(w http.ResponseWriter, r *http.Request) {
	agent, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListAgentProjectMcpServers(r.Context(), db.ListAgentProjectMcpServersParams{
		WorkspaceID: agent.WorkspaceID, AgentID: agent.ID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project MCP servers")
		return
	}
	resp := []AgentProjectMcpServerResponse{}
	index := map[string]int{}
	for _, row := range rows {
		id := uuidToString(row.WorkspaceMcpServer.ID)
		i, seen := index[id]
		if !seen {
			i = len(resp)
			index[id] = i
			resp = append(resp, AgentProjectMcpServerResponse{
				WorkspaceMcpServerResponse: workspaceMcpServerToResponse(row.WorkspaceMcpServer),
				Projects:                   []ProjectRef{},
			})
		}
		resp[i].Projects = append(resp[i].Projects, ProjectRef{ID: uuidToString(row.ProjectID), Title: row.ProjectTitle})
	}
	writeJSON(w, http.StatusOK, resp)
}
