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
		cand("a", "pending", 1, at(10)),
		cand("a", "failed", 2, at(30)),
		cand("a", "pending", 3, at(0)),
		cand("b", "pending", 4, at(20)),
		cand("b", "pending", 5, at(5)),
		cand("c", "pending", 6, pgtype.Timestamptz{}),
		cand("c", "pending", 7, at(50)),
	})
	want := map[string]int32{"a": 2, "b": 5, "c": 7}
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

func TestListWorkspaceIssueCI_VCSPendingAndFailed(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	box := withVCSBox(t)
	connID := seedVCSConnection(t, ctx, box, "gitea", "https://gitea.test")
	failing := newVCSIssue(t, "CI failing")
	running := newVCSIssue(t, "CI running")
	green := newVCSIssue(t, "CI green")
	closed := newVCSIssue(t, "PR closed")
	t.Cleanup(func() {
		for _, id := range []string{failing.ID, running.ID, green.ID, closed.ID} {
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
	status := func(sha, context, state, ago string) {
		dbfx.Exec(t, `INSERT INTO vcs_commit_status (connection_id, sha, context, state, updated_at)
			VALUES ($1, $2, $3, $4, now() - $5::interval)`, connID, sha, context, state, ago)
	}
	pr(failing.ID, 1, "open", "sha-fail")
	status("sha-fail", "build", "passed", "20 minutes")
	status("sha-fail", "test", "failed", "5 minutes")
	pr(running.ID, 2, "open", "sha-run")
	status("sha-run", "build", "passed", "30 minutes")
	status("sha-run", "test", "pending", "12 minutes")
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
	if len(byIssue) != 2 {
		t.Fatalf("got %d issues, want only the failing and running ones: %+v", len(byIssue), resp.Issues)
	}
	if e := byIssue[failing.ID]; e.State != "failed" || e.PullRequest.Number != 1 || e.IssueStatus != "in_progress" {
		t.Errorf("failing issue = %+v", e)
	}
	e := byIssue[running.ID]
	if e.State != "pending" || e.PullRequest.Provider != "gitea" || e.Since == nil {
		t.Fatalf("running issue = %+v", e)
	}
	since, err := time.Parse(time.RFC3339, *e.Since)
	if err != nil {
		t.Fatalf("since %q: %v", *e.Since, err)
	}
	if d := time.Since(since); d < 11*time.Minute || d > 13*time.Minute {
		t.Errorf("pending since %s ago, want about 12 minutes", d)
	}
}
