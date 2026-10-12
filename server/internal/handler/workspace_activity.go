package handler

import (
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
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
// "status" is status changes only, "failures" is failed agent runs only. An
// empty kind returns everything except run outcomes.
var workspaceActivityKinds = map[string]bool{"": true, "all": true, "comments": true, "status": true, "failures": true}

// maxWorkspaceActivityToStatuses caps the `to` filter; a workspace catalog
// holds far fewer statuses than this.
const maxWorkspaceActivityToStatuses = 100

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
	// Pass back as `before` for the next page; null on the last page.
	NextCursor *string `json:"next_cursor"`
}

// A feed cursor is the (created_at, id) of the last entry on a page. Both
// sources page on that tuple, so the merged stream continues exactly where the
// previous page stopped.
func formatActivityCursor(at time.Time, id string) string {
	return at.UTC().Format(time.RFC3339Nano) + "|" + id
}

func parseActivityCursor(raw string) (pgtype.Timestamptz, pgtype.UUID, bool) {
	atRaw, idRaw, ok := strings.Cut(raw, "|")
	if !ok {
		return pgtype.Timestamptz{}, pgtype.UUID{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, atRaw)
	if err != nil {
		return pgtype.Timestamptz{}, pgtype.UUID{}, false
	}
	id, err := util.ParseUUID(idRaw)
	if err != nil {
		return pgtype.Timestamptz{}, pgtype.UUID{}, false
	}
	return pgtype.Timestamptz{Time: at, Valid: true}, id, true
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
	var beforeAt pgtype.Timestamptz
	var beforeID pgtype.UUID
	if raw := r.URL.Query().Get("before"); raw != "" {
		var ok bool
		if beforeAt, beforeID, ok = parseActivityCursor(raw); !ok {
			writeError(w, http.StatusBadRequest, "invalid before cursor")
			return
		}
	}
	kind := r.URL.Query().Get("kind")
	if !workspaceActivityKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind must be all, comments, status or failures")
		return
	}
	// `to` narrows the status feed to changes into any of the given status
	// keys (comma-separated), e.g. every move to Blocked.
	toStatuses := []string{}
	if raw := r.URL.Query().Get("to"); raw != "" {
		if kind != "status" {
			writeError(w, http.StatusBadRequest, "to requires kind=status")
			return
		}
		toStatuses = strings.Split(raw, ",")
		if len(toStatuses) > maxWorkspaceActivityToStatuses || slices.Contains(toStatuses, "") {
			writeError(w, http.StatusBadRequest, "to must be a comma-separated list of status keys")
			return
		}
	}
	// Non-nil on purpose: pgx sends a nil slice as NULL, and
	// cardinality(NULL) = 0 is not true, which would filter out every row.
	onlyActions := []string{}
	excludedActions := workspaceActivityExcludedActions
	switch kind {
	case "status":
		onlyActions = []string{"status_changed"}
	case "failures":
		// Failed runs are kept out of the main feed as noise, but a stuck
		// agent has to be findable, so this tab opts back into them.
		onlyActions = []string{"task_failed"}
		excludedActions = []string{}
	}

	ctx := r.Context()
	wsUUID := parseUUID(workspaceID)
	var activities []db.ListRecentWorkspaceActivitiesRow
	if kind != "comments" {
		rows, err := h.Queries.ListRecentWorkspaceActivities(ctx, db.ListRecentWorkspaceActivitiesParams{
			WorkspaceID:     wsUUID,
			ExcludedActions: excludedActions,
			OnlyActions:     onlyActions,
			ToStatuses:      toStatuses,
			BeforeAt:        beforeAt,
			BeforeID:        beforeID,
			RowLimit:        int32(limit),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list activity")
			return
		}
		activities = rows
	}
	var comments []db.ListRecentWorkspaceCommentsRow
	if kind != "status" && kind != "failures" {
		rows, err := h.Queries.ListRecentWorkspaceComments(ctx, db.ListRecentWorkspaceCommentsParams{
			WorkspaceID:   wsUUID,
			ExcerptLength: workspaceActivityExcerptLength,
			BeforeAt:      beforeAt,
			BeforeID:      beforeID,
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
	// Ordered like the SQL (created_at DESC, id DESC): uuid order in Postgres
	// is the order of the canonical lowercase strings.
	sort.SliceStable(rows, func(i, j int) bool {
		if !rows[i].at.Time.Equal(rows[j].at.Time) {
			return rows[i].at.Time.After(rows[j].at.Time)
		}
		return rows[i].entry.ID > rows[j].entry.ID
	})
	var nextCursor *string
	if len(rows) >= limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		cursor := formatActivityCursor(last.at.Time, last.entry.ID)
		nextCursor = &cursor
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
	writeJSON(w, http.StatusOK, WorkspaceActivityResponse{Entries: entries, NextCursor: nextCursor})
}

// RecentlyCompletedEntry is an issue in a finished status and when it got
// there, for the Dashboard's Done / Cancelled tabs.
type RecentlyCompletedEntry struct {
	Issue WorkspaceActivityIssueRef `json:"issue"`
	// When the issue entered its current status: the latest status change to
	// it, or the issue's updated_at when it never changed into it.
	CompletedAt string `json:"completed_at"`
	// Who moved it there; empty when no status change is on record.
	ActorType string `json:"actor_type,omitempty"`
	ActorID   string `json:"actor_id,omitempty"`
}

type RecentlyCompletedResponse struct {
	Entries []RecentlyCompletedEntry `json:"entries"`
	// Pass back as `offset` for the next page; null on the last page.
	NextOffset *int `json:"next_offset"`
}

// recentlyCompletedCategories are the lifecycle categories whose tab orders by
// when an issue got there rather than by when it was last touched.
var recentlyCompletedCategories = map[string]bool{"done": true, "closed": true}

// ListRecentlyCompletedIssues returns issues in the requested finished
// category (`done` or `closed`), newest first by when they entered their
// current status, so a done issue that later gets a comment keeps its place.
func (h *Handler) ListRecentlyCompletedIssues(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	category := r.URL.Query().Get("category")
	if !recentlyCompletedCategories[category] {
		writeError(w, http.StatusBadRequest, "category must be done or closed")
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
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "offset must be a non-negative integer")
			return
		}
		offset = n
	}

	ctx := r.Context()
	wsUUID := parseUUID(workspaceID)
	statuses, err := issuestatus.ExpandCategories(ctx, h.Queries, wsUUID, []string{category})
	if err != nil {
		slog.Warn("expand status categories failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to resolve status categories")
		return
	}
	rows, err := h.Queries.ListIssuesByStatusEnteredAt(ctx, db.ListIssuesByStatusEnteredAtParams{
		WorkspaceID: wsUUID,
		Statuses:    statuses,
		RowLimit:    int32(limit),
		RowOffset:   int32(offset),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list completed issues")
		return
	}

	prefix := h.getIssuePrefix(ctx, wsUUID)
	entries := make([]RecentlyCompletedEntry, len(rows))
	for i, row := range rows {
		entries[i] = RecentlyCompletedEntry{
			Issue: WorkspaceActivityIssueRef{
				ID:         uuidToString(row.ID),
				Identifier: prefix + "-" + strconv.Itoa(int(row.Number)),
				Title:      row.Title,
				Status:     row.Status,
			},
			CompletedAt: timestampToString(row.EnteredAt),
			ActorType:   row.ActorType.String,
			ActorID:     uuidToString(row.ActorID),
		}
	}
	var nextOffset *int
	if len(entries) == limit {
		next := offset + limit
		nextOffset = &next
	}
	writeJSON(w, http.StatusOK, RecentlyCompletedResponse{Entries: entries, NextOffset: nextOffset})
}
