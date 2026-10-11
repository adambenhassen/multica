package handler

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func workspaceActivityRequest(path, workspaceID, userID string) *http.Request {
	req := newRequest(http.MethodGet, path, nil)
	req.Header.Set("X-Workspace-ID", workspaceID)
	req.Header.Set("X-User-ID", userID)
	return req
}

func TestListWorkspaceActivity(t *testing.T) {
	ws := dbfx.Workspace(t, "Activity feed", "activity-feed-"+uuid.NewString(), testutil.Cols{"issue_prefix": "FEED"})
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Feed issue", testutil.Cols{"workspace_id": ws, "status": "in_progress"})

	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	insert := func(issueID any, action string, at time.Time) string {
		return dbfx.Insert(t, "activity_log", testutil.Cols{
			"workspace_id": ws, "issue_id": issueID, "actor_type": "member", "actor_id": testUserID,
			"action": action, "details": `{"from":"todo","to":"in_progress"}`, "created_at": at,
		})
	}
	var newestFirst []string
	for i := range 12 {
		newestFirst = append([]string{insert(issue, "status_changed", base.Add(time.Duration(i)*time.Minute))}, newestFirst...)
	}
	// Newer than every visible row, so a leak would sort to the top.
	later := base.Add(time.Hour)
	insert(nil, "agent_env_revealed", later)
	for _, noise := range []string{"wakeup_triggered", "task_completed", "task_failed", "squad_leader_evaluated"} {
		insert(issue, noise, later)
	}
	dbfx.Comment(t, issue, "deleted", testutil.Cols{"workspace_id": ws, "created_at": later, "deleted_at": later})
	dbfx.Comment(t, issue, "progress", testutil.Cols{"workspace_id": ws, "created_at": later, "type": "progress_update"})
	other := dbfx.Workspace(t, "Other feed", "activity-feed-other-"+uuid.NewString())
	otherIssue := dbfx.Issue(t, "Other issue", testutil.Cols{"workspace_id": other})
	dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": other, "issue_id": otherIssue, "actor_type": "member", "actor_id": testUserID,
		"action": "status_changed", "created_at": later,
	})

	var got WorkspaceActivityResponse
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity", ws, testUserID)).
		Want(http.StatusOK).JSON(&got)
	if len(got.Entries) != defaultWorkspaceActivityLimit {
		t.Fatalf("default page = %d entries, want %d", len(got.Entries), defaultWorkspaceActivityLimit)
	}
	for i, entry := range got.Entries {
		if entry.ID != newestFirst[i] {
			t.Fatalf("entry %d = %s, want %s (newest first, no audit/wakeup/foreign rows)", i, entry.ID, newestFirst[i])
		}
	}
	first := got.Entries[0]
	wantIssue := WorkspaceActivityIssueRef{ID: issue, Identifier: fmt.Sprintf("FEED-%d", 1), Title: "Feed issue", Status: "in_progress"}
	if first.Issue != wantIssue {
		t.Fatalf("issue ref = %+v, want %+v", first.Issue, wantIssue)
	}
	if first.Type != "activity" || first.Action == nil || *first.Action != "status_changed" {
		t.Fatalf("entry = %+v, want a status_changed activity", first.TimelineEntry)
	}
	if first.ActorName == "" {
		t.Fatal("member actor name was not hydrated")
	}

	var all WorkspaceActivityResponse
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?limit=500", ws, testUserID)).
		Want(http.StatusOK).JSON(&all)
	if len(all.Entries) != len(newestFirst) {
		t.Fatalf("capped page = %d entries, want all %d visible rows", len(all.Entries), len(newestFirst))
	}

	for _, query := range []string{"limit=0", "limit=-1", "limit=ten"} {
		testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?"+query, ws, testUserID)).
			Want(http.StatusBadRequest)
	}

	outsider := dbfx.User(t, "Outsider", "outsider-"+uuid.NewString()+"@example.com")
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity", ws, outsider)).
		WantOneOf(http.StatusForbidden, http.StatusNotFound)
}

func TestListWorkspaceActivityMergesCommentsAndFiltersByKind(t *testing.T) {
	ws := dbfx.Workspace(t, "Feed comments", "feed-comments-"+uuid.NewString(), testutil.Cols{"issue_prefix": "FC"})
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Commented issue", testutil.Cols{"workspace_id": ws})
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)

	status := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": issue, "actor_type": "member", "actor_id": testUserID,
		"action": "status_changed", "details": `{"from":"todo","to":"done"}`, "created_at": base,
	})
	assigned := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": issue, "actor_type": "member", "actor_id": testUserID,
		"action": "assignee_changed", "created_at": base.Add(time.Minute),
	})
	long := strings.Repeat("x", workspaceActivityExcerptLength+100)
	comment := dbfx.Comment(t, issue, long, testutil.Cols{"workspace_id": ws, "created_at": base.Add(2 * time.Minute)})

	read := func(query string) WorkspaceActivityResponse {
		var out WorkspaceActivityResponse
		testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity"+query, ws, testUserID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	ids := func(out WorkspaceActivityResponse) []string {
		got := make([]string, len(out.Entries))
		for i, e := range out.Entries {
			got[i] = e.ID
		}
		return got
	}

	all := read("")
	if want := []string{comment, assigned, status}; !slices.Equal(ids(all), want) {
		t.Fatalf("all = %v, want newest-first %v", ids(all), want)
	}
	first := all.Entries[0]
	if first.Type != "comment" || first.Content == nil || len(*first.Content) != workspaceActivityExcerptLength {
		t.Fatalf("comment entry = %+v, want a comment carrying a %d-char excerpt", first.TimelineEntry, workspaceActivityExcerptLength)
	}
	if first.Issue.Identifier != "FC-1" {
		t.Fatalf("comment issue = %+v", first.Issue)
	}
	if got := ids(read("?kind=comments")); !slices.Equal(got, []string{comment}) {
		t.Fatalf("kind=comments = %v", got)
	}
	if got := ids(read("?kind=status")); !slices.Equal(got, []string{status}) {
		t.Fatalf("kind=status = %v", got)
	}
	if got := ids(read("?kind=all&limit=2")); !slices.Equal(got, []string{comment, assigned}) {
		t.Fatalf("limit=2 = %v", got)
	}
	failed := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": issue, "actor_type": "agent", "actor_id": testUserID,
		"action": "task_failed", "created_at": base.Add(3 * time.Minute),
	})
	if got := ids(read("")); slices.Contains(got, failed) {
		t.Fatalf("all = %v, must not carry failed runs", got)
	}
	if got := ids(read("?kind=failures")); !slices.Equal(got, []string{failed}) {
		t.Fatalf("kind=failures = %v, want only the failed run", got)
	}
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?kind=runs", ws, testUserID)).
		Want(http.StatusBadRequest)
}
