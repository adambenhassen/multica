package handler

import (
	"net/http"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestActivityPins(t *testing.T) {
	ws := dbfx.Workspace(t, "Activity pins", "activity-pins-"+uuid.NewString(), testutil.Cols{"issue_prefix": "APIN"})
	dbfx.Member(t, ws, testUserID, "owner")
	first := dbfx.Issue(t, "First", testutil.Cols{"workspace_id": ws})
	second := dbfx.Issue(t, "Second", testutil.Cols{"workspace_id": ws})
	foreign := dbfx.Issue(t, "Foreign", testutil.Cols{"workspace_id": dbfx.Workspace(t, "Other pins", "activity-pins-other-"+uuid.NewString())})

	call := func(method, issueID string) *testutil.Response {
		req := workspaceActivityRequest("/api/activity/pins/"+issueID, ws, testUserID)
		req.Method = method
		req = withURLParam(req, "issueId", issueID)
		handler := testHandler.PinActivityIssue
		if method == http.MethodDelete {
			handler = testHandler.UnpinActivityIssue
		}
		return testutil.Call(t, handler, req)
	}
	list := func() []string {
		var got ActivityPinsResponse
		testutil.Call(t, testHandler.ListActivityPins, workspaceActivityRequest("/api/activity/pins", ws, testUserID)).
			Want(http.StatusOK).JSON(&got)
		return got.IssueIDs
	}

	if got := list(); len(got) != 0 {
		t.Fatalf("pins before pinning = %v, want none", got)
	}
	call(http.MethodPut, first).Want(http.StatusNoContent)
	call(http.MethodPut, second).Want(http.StatusNoContent)
	// Pinning twice is not an error and adds no second row.
	call(http.MethodPut, first).Want(http.StatusNoContent)
	if got, want := list(), []string{first, second}; !slices.Equal(got, want) {
		t.Fatalf("pins = %v, want %v (oldest pin first)", got, want)
	}
	// Another workspace's issue cannot be pinned here.
	call(http.MethodPut, foreign).Want(http.StatusNotFound)

	call(http.MethodDelete, first).Want(http.StatusNoContent)
	call(http.MethodDelete, first).Want(http.StatusNoContent)
	if got, want := list(), []string{second}; !slices.Equal(got, want) {
		t.Fatalf("pins after unpinning = %v, want %v", got, want)
	}
	call(http.MethodDelete, "not-a-uuid").Want(http.StatusBadRequest)

	// Deleting the issue takes its pins with it.
	req := newRequest(http.MethodDelete, "/api/issues/"+second, nil)
	req.Header.Set("X-Workspace-ID", ws)
	req = withURLParam(req, "id", second)
	testutil.Call(t, testHandler.DeleteIssue, req).Want(http.StatusNoContent)
	if got := list(); len(got) != 0 {
		t.Fatalf("pins after deleting the issue = %v, want none", got)
	}
}
