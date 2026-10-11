package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// AddProjectSkillsRequest attaches workspace skills to a project.
type AddProjectSkillsRequest struct {
	SkillIDs []string `json:"skill_ids"`
}

// canManageProjectSkills limits attaching and detaching project skills to
// human workspace owners and admins. A project skill reaches every agent that
// runs in the project, including agents the caller could not edit directly.
// Machine credentials are refused even when their owner is an admin: an agent
// steered by a prompt injection must not be able to plant instructions in
// every other agent's runs.
func (h *Handler) canManageProjectSkills(w http.ResponseWriter, r *http.Request, project db.Project) bool {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "only people can change project skills")
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
	resp := make([]SkillSummaryResponse, len(skills))
	for i, s := range skills {
		resp[i] = skillSummaryToResponse(
			s.ID, s.WorkspaceID, s.Name, s.Description, s.Config,
			s.CreatedBy, s.CreatedAt, s.UpdatedAt,
		)
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
	if !h.canManageProjectSkills(w, r, project) {
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
	skillUUIDs, ok := parseUUIDSliceOrBadRequest(w, req.SkillIDs, "skill_ids")
	if !ok {
		return
	}
	unique := make(map[[16]byte]struct{}, len(skillUUIDs))
	for _, id := range skillUUIDs {
		unique[id.Bytes] = struct{}{}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
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
	for _, skillID := range skillUUIDs {
		if err := qtx.AddProjectSkill(r.Context(), db.AddProjectSkillParams{
			ProjectID:   project.ID,
			SkillID:     skillID,
			WorkspaceID: project.WorkspaceID,
			CreatedBy:   creator,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to add project skill")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}

	h.publish(
		protocol.EventProjectSkillCreated,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{
			"project_id": uuidToString(project.ID),
			"skill_ids":  req.SkillIDs,
		},
	)
	h.writeProjectSkills(w, r, project)
}

// RemoveProjectSkill detaches a skill from a project.
func (h *Handler) RemoveProjectSkill(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	if !h.canManageProjectSkills(w, r, project) {
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
