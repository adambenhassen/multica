package handler

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxProjectSkillsPerRequest = 100

// AddProjectSkillsRequest attaches workspace skills to a project.
type AddProjectSkillsRequest struct {
	SkillIDs []string `json:"skill_ids"`
}

// canManageProjectRunConfig limits attaching and detaching project skills and
// MCP servers to human workspace owners and admins. Both reach every agent that
// runs in the project, including agents the caller could not edit directly.
// Machine credentials are refused even when their owner is an admin: an agent
// steered by a prompt injection must not be able to plant instructions in
// every other agent's runs.
func (h *Handler) canManageProjectRunConfig(w http.ResponseWriter, r *http.Request, project db.Project) bool {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "only people can change what a project gives its agents")
		return false
	}
	_, ok := h.requireWorkspaceRole(w, r, uuidToString(project.WorkspaceID), "project not found", "owner", "admin")
	return ok
}

// ListProjectSkills returns the skills attached to a project. Every task that
// runs in the project receives them alongside its agent's own skills.
func (h *Handler) ListProjectSkills(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	h.writeProjectSkills(w, r, project)
}

func (h *Handler) writeProjectSkills(w http.ResponseWriter, r *http.Request, project db.Project) {
	skills, err := h.Queries.ListProjectSkillSummaries(r.Context(), db.ListProjectSkillSummariesParams{
		ProjectID:   project.ID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project skills")
		return
	}
	targets, err := h.loadProjectAudienceTargets(r.Context(), project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project skills")
		return
	}
	resp := make([]ProjectSkillResponse, len(skills))
	for i, s := range skills {
		resp[i] = ProjectSkillResponse{
			SkillSummaryResponse: skillSummaryToResponse(
				s.ID, s.WorkspaceID, s.Name, s.Description, s.Config,
				s.CreatedBy, s.CreatedAt, s.UpdatedAt,
			),
			Audience: audienceFor(targets, projectAttachmentSkill, s.ID, s.Restricted),
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// AddProjectSkills attaches workspace skills to a project and returns the
// project's updated skill list. Attaching an attached skill is a no-op.
func (h *Handler) AddProjectSkills(w http.ResponseWriter, r *http.Request) {
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
	var req AddProjectSkillsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.SkillIDs) == 0 {
		writeError(w, http.StatusBadRequest, "skill_ids is required")
		return
	}
	// Each id is a locked row and an insert inside one transaction; bound it.
	if len(req.SkillIDs) > maxProjectSkillsPerRequest {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("skill_ids accepts at most %d ids", maxProjectSkillsPerRequest))
		return
	}
	skillUUIDs, ok := parseUUIDSliceOrBadRequest(w, req.SkillIDs, "skill_ids")
	if !ok {
		return
	}
	unique := make(map[[16]byte]struct{}, len(skillUUIDs))
	uniqueUUIDs := make([]pgtype.UUID, 0, len(skillUUIDs))
	for _, id := range skillUUIDs {
		if _, dup := unique[id.Bytes]; dup {
			continue
		}
		unique[id.Bytes] = struct{}{}
		uniqueUUIDs = append(uniqueUUIDs, id)
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
	// Validate inside the transaction so a skill deleted concurrently cannot
	// leave a link behind; project_skill has no foreign key to catch it.
	found, err := qtx.LockSkillsInWorkspace(r.Context(), db.LockSkillsInWorkspaceParams{
		SkillIds:    skillUUIDs,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load skills")
		return
	}
	if len(found) != len(unique) {
		writeError(w, http.StatusNotFound, "skill not found")
		return
	}
	creator, _ := h.parseUserUUIDOrZero(userID)
	// Only newly attached skills are announced; re-attaching is a no-op.
	added := make([]string, 0, len(uniqueUUIDs))
	for _, skillID := range uniqueUUIDs {
		rows, err := qtx.AddProjectSkill(r.Context(), db.AddProjectSkillParams{
			ProjectID:   project.ID,
			SkillID:     skillID,
			WorkspaceID: project.WorkspaceID,
			CreatedBy:   creator,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add project skill")
			return
		}
		if rows > 0 {
			added = append(added, uuidToString(skillID))
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}

	if len(added) > 0 {
		h.publish(
			protocol.EventProjectSkillCreated,
			uuidToString(project.WorkspaceID),
			"member",
			userID,
			map[string]any{
				"project_id": uuidToString(project.ID),
				"skill_ids":  added,
			},
		)
	}
	h.writeProjectSkills(w, r, project)
}

// RemoveProjectSkill detaches a skill from a project.
func (h *Handler) RemoveProjectSkill(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !h.canManageProjectRunConfig(w, r, project) {
		return
	}
	skillUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "skillId"), "skill id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	removed, err := h.Queries.RemoveProjectSkill(r.Context(), db.RemoveProjectSkillParams{
		ProjectID:   project.ID,
		SkillID:     skillUUID,
		WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove project skill")
		return
	}
	if removed == 0 {
		writeError(w, http.StatusNotFound, "project skill not found")
		return
	}

	h.publish(
		protocol.EventProjectSkillDeleted,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{
			"project_id": uuidToString(project.ID),
			"skill_id":   uuidToString(skillUUID),
		},
	)
	w.WriteHeader(http.StatusNoContent)
}
