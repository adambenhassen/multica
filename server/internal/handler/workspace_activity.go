package handler

import (
	"net/http"
	"strconv"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	defaultWorkspaceActivityLimit = 10
	maxWorkspaceActivityLimit     = 50
)

// workspaceActivityExcludedActions are issue timeline entries that only make
// sense inside the issue's own timeline: wakeup rule bookkeeping is rendered
// there with the rule preview, and would read as noise in a workspace feed.
var workspaceActivityExcludedActions = []string{
	"wakeup_created",
	"wakeup_triggered",
	"wakeup_timed_out",
	"wakeup_checkin",
	"wakeup_paused",
}

// WorkspaceActivityIssueRef names the issue an activity entry belongs to, so
// the feed renders without a per-row issue fetch.
type WorkspaceActivityIssueRef struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Title      string `json:"title"`
	Status     string `json:"status"`
}

type WorkspaceActivityEntry struct {
	TimelineEntry
	Issue WorkspaceActivityIssueRef `json:"issue"`
}

type WorkspaceActivityResponse struct {
	Entries []WorkspaceActivityEntry `json:"entries"`
}

// ListWorkspaceActivity returns the newest issue activity across the
// workspace, newest first. Every member can read every issue, so the feed
// exposes nothing the per-issue timeline does not.
func (h *Handler) ListWorkspaceActivity(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}

	limit := defaultWorkspaceActivityLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, maxWorkspaceActivityLimit)
	}

	ctx := r.Context()
	wsUUID := parseUUID(workspaceID)
	rows, err := h.Queries.ListRecentWorkspaceActivities(ctx, db.ListRecentWorkspaceActivitiesParams{
		WorkspaceID:     wsUUID,
		ExcludedActions: workspaceActivityExcludedActions,
		RowLimit:        int32(limit),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list activity")
		return
	}

	timeline := make([]TimelineEntry, len(rows))
	for i, row := range rows {
		timeline[i] = activityToEntry(db.ActivityLog{
			ID:          row.ID,
			WorkspaceID: row.WorkspaceID,
			IssueID:     row.IssueID,
			ActorType:   row.ActorType,
			ActorID:     row.ActorID,
			Action:      row.Action,
			Details:     row.Details,
			CreatedAt:   row.CreatedAt,
		})
	}
	h.hydrateTimelineMemberActors(ctx, timeline)

	prefix := h.getIssuePrefix(ctx, wsUUID)
	entries := make([]WorkspaceActivityEntry, len(rows))
	for i, row := range rows {
		entries[i] = WorkspaceActivityEntry{
			TimelineEntry: timeline[i],
			Issue: WorkspaceActivityIssueRef{
				ID:         uuidToString(row.IssueID),
				Identifier: prefix + "-" + strconv.Itoa(int(row.IssueNumber)),
				Title:      row.IssueTitle,
				Status:     row.IssueStatus,
			},
		}
	}
	writeJSON(w, http.StatusOK, WorkspaceActivityResponse{Entries: entries})
}
