package handler

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	defaultWorkspaceActivityLimit = 10
	maxWorkspaceActivityLimit     = 50
	// The feed shows one line of a comment; the full body stays on the issue.
	workspaceActivityExcerptLength = 280
)

// workspaceActivityExcludedActions are issue timeline entries that only make
// sense inside the issue's own timeline: wakeup rule bookkeeping is rendered
// there with the rule preview, and run outcomes fire on every agent turn, so
// both would drown out the human-meaningful changes in a workspace feed.
var workspaceActivityExcludedActions = []string{
	"task_completed",
	"task_failed",
	"squad_leader_evaluated",
	"wakeup_created",
	"wakeup_triggered",
	"wakeup_timed_out",
	"wakeup_checkin",
	"wakeup_paused",
}

// workspaceActivityKinds narrows the feed: "comments" is comments only,
// "status" is status changes only. An empty kind returns everything.
var workspaceActivityKinds = map[string]bool{"": true, "all": true, "comments": true, "status": true}

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

// ListWorkspaceActivity returns the newest issue activity and comments across
// the workspace, newest first. Every member can read every issue, so the feed
// exposes nothing the per-issue timeline does not. Comment entries carry only
// an excerpt of their content.
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
	kind := r.URL.Query().Get("kind")
	if !workspaceActivityKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind must be all, comments or status")
		return
	}
	// Non-nil on purpose: pgx sends a nil slice as NULL, and
	// cardinality(NULL) = 0 is not true, which would filter out every row.
	onlyActions := []string{}
	if kind == "status" {
		onlyActions = []string{"status_changed"}
	}

	ctx := r.Context()
	wsUUID := parseUUID(workspaceID)
	var activities []db.ListRecentWorkspaceActivitiesRow
	if kind != "comments" {
		rows, err := h.Queries.ListRecentWorkspaceActivities(ctx, db.ListRecentWorkspaceActivitiesParams{
			WorkspaceID:     wsUUID,
			ExcludedActions: workspaceActivityExcludedActions,
			OnlyActions:     onlyActions,
			RowLimit:        int32(limit),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list activity")
			return
		}
		activities = rows
	}
	var comments []db.ListRecentWorkspaceCommentsRow
	if kind != "status" {
		rows, err := h.Queries.ListRecentWorkspaceComments(ctx, db.ListRecentWorkspaceCommentsParams{
			WorkspaceID:   wsUUID,
			ExcerptLength: workspaceActivityExcerptLength,
			RowLimit:      int32(limit),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list activity")
			return
		}
		comments = rows
	}

	type feedRow struct {
		at    pgtype.Timestamptz
		entry TimelineEntry
		issue WorkspaceActivityIssueRef
	}
	prefix := h.getIssuePrefix(ctx, wsUUID)
	issueRef := func(id pgtype.UUID, number int32, title, status string) WorkspaceActivityIssueRef {
		return WorkspaceActivityIssueRef{
			ID:         uuidToString(id),
			Identifier: prefix + "-" + strconv.Itoa(int(number)),
			Title:      title,
			Status:     status,
		}
	}
	rows := make([]feedRow, 0, len(activities)+len(comments))
	for _, a := range activities {
		rows = append(rows, feedRow{
			at: a.CreatedAt,
			entry: activityToEntry(db.ActivityLog{
				ID:          a.ID,
				WorkspaceID: a.WorkspaceID,
				IssueID:     a.IssueID,
				ActorType:   a.ActorType,
				ActorID:     a.ActorID,
				Action:      a.Action,
				Details:     a.Details,
				CreatedAt:   a.CreatedAt,
			}),
			issue: issueRef(a.IssueID, a.IssueNumber, a.IssueTitle, a.IssueStatus),
		})
	}
	for _, c := range comments {
		excerpt := c.Excerpt
		rows = append(rows, feedRow{
			at: c.CreatedAt,
			entry: TimelineEntry{
				Type:      "comment",
				ID:        uuidToString(c.ID),
				ActorType: c.AuthorType,
				ActorID:   uuidToString(c.AuthorID),
				Content:   &excerpt,
				ParentID:  uuidToPtr(c.ParentID),
				CreatedAt: timestampToString(c.CreatedAt),
			},
			issue: issueRef(c.IssueID, c.IssueNumber, c.IssueTitle, c.IssueStatus),
		})
	}
	// Each source is already newest-first and capped at limit, so the merged
	// head is the true newest `limit` across both.
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].at.Time.After(rows[j].at.Time) })
	if len(rows) > limit {
		rows = rows[:limit]
	}

	timeline := make([]TimelineEntry, len(rows))
	for i, row := range rows {
		timeline[i] = row.entry
	}
	h.hydrateTimelineMemberActors(ctx, timeline)

	entries := make([]WorkspaceActivityEntry, len(rows))
	for i, row := range rows {
		entries[i] = WorkspaceActivityEntry{TimelineEntry: timeline[i], Issue: row.issue}
	}
	writeJSON(w, http.StatusOK, WorkspaceActivityResponse{Entries: entries})
}
