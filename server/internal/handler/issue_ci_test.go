package handler

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestMergeIssueCIStates(t *testing.T) {
	at := func(min int) pgtype.Timestamptz {
		return pgtype.Timestamptz{Time: time.Date(2026, 10, 30, 6, min, 0, 0, time.UTC), Valid: true}
	}
	cand := func(issue, state string, pr int32, since pgtype.Timestamptz) issueCICandidate {
		return issueCICandidate{
			resp:  IssueCIStateResponse{IssueID: issue, State: state, PullRequest: IssueCIPullRequest{Number: pr}},
			since: since,
		}
	}
	got := mergeIssueCIStates([]issueCICandidate{
		cand("a", "running", 1, at(10)),
		cand("a", "failed", 2, at(30)),
		cand("a", "queued", 3, at(0)),
		cand("b", "running", 4, at(20)),
		cand("b", "running", 5, at(5)),
		cand("c", "queued", 6, pgtype.Timestamptz{}),
		cand("c", "queued", 7, at(50)),
		cand("d", "queued", 8, at(1)),
		cand("d", "running", 9, at(40)),
	})
	want := map[string]int32{"a": 2, "b": 5, "c": 7, "d": 9}
	if len(got) != len(want) {
		t.Fatalf("got %d issues, want %d: %+v", len(got), len(want), got)
	}
	for _, g := range got {
		if g.PullRequest.Number != want[g.IssueID] {
			t.Errorf("issue %s: PR #%d, want #%d", g.IssueID, g.PullRequest.Number, want[g.IssueID])
		}
	}
	if got[0].IssueID != "a" || got[0].Since == nil {
		t.Errorf("first entry = %+v, want issue a with a since time", got[0])
	}
}

func TestIssueCIState(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		conclusion      *string
		started, queued int64
		want            string
	}{
		{nil, 0, 0, ""},
		{str("passed"), 0, 0, ""},
		{str("failed"), 1, 3, "failed"},
		{str("pending"), 1, 3, "running"},
		{str("pending"), 0, 3, "queued"},
		// A rollup says pending but no check row is counted: still CI going.
		{str("pending"), 0, 0, "running"},
	}
	for _, c := range cases {
		if got := issueCIState(c.conclusion, c.started, c.queued); got != c.want {
			t.Errorf("issueCIState(%v, %d, %d) = %q, want %q", c.conclusion, c.started, c.queued, got, c.want)
		}
	}
}

func TestListWorkspaceIssueCI_VCSStates(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	box := withVCSBox(t)
	connID := seedVCSConnection(t, ctx, box, "gitea", "https://gitea.test")
	failing := newVCSIssue(t, "CI failing")
	running := newVCSIssue(t, "CI running")
	queued := newVCSIssue(t, "CI queued")
	green := newVCSIssue(t, "CI green")
	closed := newVCSIssue(t, "PR closed")
	t.Cleanup(func() {
		for _, id := range []string{failing.ID, running.ID, queued.ID, green.ID, closed.ID} {
			cleanupVCS(ctx, id)
		}
	})

	pr := func(issueID string, number int, state, head string) {
		prID := dbfx.Insert(t, "vcs_pull_request", testutil.Cols{
			"workspace_id":  testWorkspaceID,
			"connection_id": connID,
			"provider":      "gitea",
			"repo_owner":    "acme",
			"repo_name":     "widget",
			"pr_number":     number,
			"title":         "PR",
			"state":         state,
			"html_url":      "https://gitea.test/acme/widget/pulls",
			"head_sha":      head,
			"pr_created_at": testutil.Raw("now()"),
			"pr_updated_at": testutil.Raw("now()"),
		})
		dbfx.Exec(t, `INSERT INTO issue_vcs_pull_request (issue_id, pull_request_id) VALUES ($1, $2)`, issueID, prID)
	}
	described := func(sha, context, state, description, ago string) {
		dbfx.Exec(t, `INSERT INTO vcs_commit_status (connection_id, sha, context, state, description, updated_at)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), now() - $6::interval)`, connID, sha, context, state, description, ago)
	}
	status := func(sha, context, state, ago string) { described(sha, context, state, "", ago) }
	pr(failing.ID, 1, "open", "sha-fail")
	status("sha-fail", "build", "passed", "20 minutes")
	status("sha-fail", "test", "failed", "5 minutes")
	pr(running.ID, 2, "open", "sha-run")
	status("sha-run", "build", "passed", "30 minutes")
	described("sha-run", "test", "pending", "In progress", "12 minutes")
	described("sha-run", "e2e", "pending", "Waiting to run", "40 minutes")
	pr(queued.ID, 5, "open", "sha-queued")
	described("sha-queued", "test", "pending", "Waiting to run", "25 minutes")
	described("sha-queued", "deploy", "pending", "Blocked by required conditions", "30 minutes")
	// A failure on an older head commit no longer counts.
	status("sha-old", "test", "failed", "40 minutes")
	pr(green.ID, 3, "open", "sha-green")
	status("sha-green", "test", "passed", "1 minute")
	pr(closed.ID, 4, "closed", "sha-closed")
	status("sha-closed", "test", "failed", "1 minute")

	var resp struct {
		Issues []IssueCIStateResponse `json:"issues"`
	}
	testutil.Call(t, testHandler.ListWorkspaceIssueCI, newRequest("GET", "/api/issue-ci", nil)).
		Want(http.StatusOK).JSON(&resp)

	byIssue := map[string]IssueCIStateResponse{}
	for _, e := range resp.Issues {
		byIssue[e.IssueID] = e
	}
	if len(byIssue) != 3 {
		t.Fatalf("got %d issues, want the failing, running and queued ones: %+v", len(byIssue), resp.Issues)
	}
	if e := byIssue[failing.ID]; e.State != "failed" || e.PullRequest.Number != 1 || e.IssueStatus != "in_progress" {
		t.Errorf("failing issue = %+v", e)
	}
	// Running since its started check, not its still-queued one.
	wantSince(t, byIssue[running.ID], "running", 12*time.Minute)
	wantSince(t, byIssue[queued.ID], "queued", 30*time.Minute)
}

func wantSince(t *testing.T, e IssueCIStateResponse, state string, ago time.Duration) {
	t.Helper()
	if e.State != state || e.PullRequest.Provider != "gitea" || e.Since == nil {
		t.Fatalf("entry = %+v, want state %q with a since time", e, state)
	}
	since, err := time.Parse(time.RFC3339, *e.Since)
	if err != nil {
		t.Fatalf("since %q: %v", *e.Since, err)
	}
	if d := time.Since(since); d < ago-time.Minute || d > ago+time.Minute {
		t.Errorf("%s since %s ago, want about %s", state, d, ago)
	}
}
