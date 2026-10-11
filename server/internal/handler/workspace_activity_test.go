package handler

import (
	"fmt"
	"net/http"
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
	insert(issue, "wakeup_triggered", later)
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
