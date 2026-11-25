package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ActivityPinsResponse lists the issues the member pinned to the top of the
// Activity feed, oldest pin first.
type ActivityPinsResponse struct {
	IssueIDs []string `json:"issue_ids"`
}

func (h *Handler) ListActivityPins(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	ids, err := h.Queries.ListActivityPins(r.Context(), db.ListActivityPinsParams{
		WorkspaceID: wsUUID,
		UserID:      parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list activity pins")
		return
	}
	resp := ActivityPinsResponse{IssueIDs: make([]string, 0, len(ids))}
	for _, id := range ids {
		resp.IssueIDs = append(resp.IssueIDs, uuidToString(id))
	}
	writeJSON(w, http.StatusOK, resp)
}

// PinActivityIssue pins an issue to the top of the caller's Activity feed.
// Pinning an already pinned issue succeeds.
func (h *Handler) PinActivityIssue(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	if err := h.Queries.CreateActivityPin(r.Context(), db.CreateActivityPinParams{
		WorkspaceID: issue.WorkspaceID,
		UserID:      parseUUID(userID),
		IssueID:     issue.ID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to pin issue")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UnpinActivityIssue removes an issue from the top of the caller's Activity
// feed. Unpinning an issue that is not pinned succeeds.
func (h *Handler) UnpinActivityIssue(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	issueUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "issueId"), "issue id")
	if !ok {
		return
	}
	if err := h.Queries.DeleteActivityPin(r.Context(), db.DeleteActivityPinParams{
		WorkspaceID: wsUUID,
		UserID:      parseUUID(userID),
		IssueID:     issueUUID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unpin issue")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
