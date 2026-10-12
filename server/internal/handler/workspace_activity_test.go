package handler

import (
	"fmt"
	"net/http"
	"net/url"
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
	if got := ids(read("?kind=status_comments")); !slices.Equal(got, []string{comment, status}) {
		t.Fatalf("kind=status_comments = %v, want the comment and the status change, not the assignment", got)
	}
	if got := ids(read("?kind=other")); !slices.Equal(got, []string{assigned}) {
		t.Fatalf("kind=other = %v, want only the assignment", got)
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

	blocked := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": issue, "actor_type": "member", "actor_id": testUserID,
		"action": "status_changed", "details": `{"from":"done","to":"blocked"}`, "created_at": base.Add(4 * time.Minute),
	})
	if got := ids(read("?kind=status&to=done")); !slices.Equal(got, []string{status}) {
		t.Fatalf("to=done = %v, want only the change into done", got)
	}
	if got := ids(read("?kind=status&to=blocked,done")); !slices.Equal(got, []string{blocked, status}) {
		t.Fatalf("to=blocked,done = %v", got)
	}
	for _, query := range []string{"?to=done", "?kind=comments&to=done", "?kind=status&to=done,"} {
		testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity"+query, ws, testUserID)).
			Want(http.StatusBadRequest)
	}

	// `issue` keeps one issue's history across activity and comments.
	other := dbfx.Issue(t, "Other issue", testutil.Cols{"workspace_id": ws})
	otherStatus := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": other, "actor_type": "member", "actor_id": testUserID,
		"action": "status_changed", "details": `{"from":"todo","to":"blocked"}`, "created_at": base.Add(5 * time.Minute),
	})
	otherComment := dbfx.Comment(t, other, "on the other issue", testutil.Cols{"workspace_id": ws, "created_at": base.Add(6 * time.Minute)})
	if got := ids(read("?issue=" + other)); !slices.Equal(got, []string{otherComment, otherStatus}) {
		t.Fatalf("issue=other = %v, want only the other issue's comment and status change", got)
	}
	if got := ids(read("?kind=status&to=blocked&issue=" + issue)); !slices.Equal(got, []string{blocked}) {
		t.Fatalf("kind=status&to=blocked&issue = %v, want only this issue's move into blocked", got)
	}
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?issue=nope", ws, testUserID)).
		Want(http.StatusBadRequest)

	// `project` keeps the issues of one project, activity and comments alike.
	project := dbfx.Insert(t, "project", testutil.Cols{"workspace_id": ws, "title": "Feed project"})
	inProject := dbfx.Issue(t, "Project issue", testutil.Cols{"workspace_id": ws, "project_id": project})
	projectStatus := dbfx.Insert(t, "activity_log", testutil.Cols{
		"workspace_id": ws, "issue_id": inProject, "actor_type": "member", "actor_id": testUserID,
		"action": "status_changed", "details": `{"from":"todo","to":"done"}`, "created_at": base.Add(7 * time.Minute),
	})
	projectComment := dbfx.Comment(t, inProject, "in the project", testutil.Cols{"workspace_id": ws, "created_at": base.Add(8 * time.Minute)})
	if got := ids(read("?project=" + project)); !slices.Equal(got, []string{projectComment, projectStatus}) {
		t.Fatalf("project = %v, want only the project issue's comment and status change", got)
	}
	if got := ids(read("?kind=status&project=" + project)); !slices.Equal(got, []string{projectStatus}) {
		t.Fatalf("kind=status&project = %v", got)
	}
	for _, e := range read("?project=" + project).Entries {
		if e.Issue.ProjectID == nil || *e.Issue.ProjectID != project {
			t.Fatalf("entry %s issue project = %v, want %s", e.ID, e.Issue.ProjectID, project)
		}
	}
	if e := read("?issue=" + other).Entries[0]; e.Issue.ProjectID != nil {
		t.Fatalf("issue without a project carries project %v", *e.Issue.ProjectID)
	}
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?project=nope", ws, testUserID)).
		Want(http.StatusBadRequest)
}

func TestListRecentlyCompletedIssuesOrdersByCompletion(t *testing.T) {
	ws := dbfx.Workspace(t, "Completed feed", "completed-feed-"+uuid.NewString(), testutil.Cols{"issue_prefix": "CF"})
	dbfx.Member(t, ws, testUserID, "owner")
	base := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Microsecond)

	// Finished long ago, but touched recently: must sort by when it finished.
	early := dbfx.Issue(t, "Done early, commented later", testutil.Cols{"workspace_id": ws, "status": "done", "updated_at": base.Add(40 * time.Hour)})
	late := dbfx.Issue(t, "Done late", testutil.Cols{"workspace_id": ws, "status": "done", "updated_at": base.Add(10 * time.Hour)})
	// Created directly as done: no status change on record, falls back to updated_at.
	direct := dbfx.Issue(t, "Created done", testutil.Cols{"workspace_id": ws, "status": "done", "updated_at": base.Add(5 * time.Hour)})
	open := dbfx.Issue(t, "Still open", testutil.Cols{"workspace_id": ws, "status": "in_progress"})
	cancelled := dbfx.Issue(t, "Dropped", testutil.Cols{"workspace_id": ws, "status": "cancelled"})
	statusChange := func(issue, to string, at time.Time) {
		dbfx.Insert(t, "activity_log", testutil.Cols{
			"workspace_id": ws, "issue_id": issue, "actor_type": "member", "actor_id": testUserID,
			"action": "status_changed", "details": `{"from":"in_progress","to":"` + to + `"}`, "created_at": at,
		})
	}
	statusChange(early, "done", base.Add(1*time.Hour))
	statusChange(late, "done", base.Add(9*time.Hour))
	statusChange(open, "done", base.Add(20*time.Hour)) // reopened since; not done now
	statusChange(cancelled, "cancelled", base.Add(30*time.Hour))

	read := func(query string) RecentlyCompletedResponse {
		var out RecentlyCompletedResponse
		testutil.Call(t, testHandler.ListRecentlyCompletedIssues, workspaceActivityRequest("/api/activity/completed"+query, ws, testUserID)).
			Want(http.StatusOK).JSON(&out)
		return out
	}
	done := read("?category=done")
	got := make([]string, len(done.Entries))
	for i, e := range done.Entries {
		got[i] = e.Issue.ID
	}
	if want := []string{late, direct, early}; !slices.Equal(got, want) {
		t.Fatalf("done order = %v, want by completion time %v", got, want)
	}
	if e := done.Entries[0]; e.ActorID != testUserID || e.ActorType != "member" || e.Issue.Identifier == "" {
		t.Fatalf("latest completion = %+v, want the member who moved it", e)
	}
	if e := done.Entries[1]; e.ActorID != "" {
		t.Fatalf("created-as-done entry = %+v, want no actor", e)
	}
	closed := read("?category=closed")
	if len(closed.Entries) != 1 || closed.Entries[0].Issue.ID != cancelled {
		t.Fatalf("closed = %+v, want only the cancelled issue", closed.Entries)
	}
	for _, query := range []string{"", "?category=started", "?category=done&limit=0"} {
		testutil.Call(t, testHandler.ListRecentlyCompletedIssues, workspaceActivityRequest("/api/activity/completed"+query, ws, testUserID)).
			Want(http.StatusBadRequest)
	}
}

func TestListWorkspaceActivityPagesThroughBothSources(t *testing.T) {
	ws := dbfx.Workspace(t, "Feed pages", "feed-pages-"+uuid.NewString(), testutil.Cols{"issue_prefix": "FP"})
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Paged issue", testutil.Cols{"workspace_id": ws})
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)

	// Interleaved sources, plus a timestamp shared across both tables, so a
	// page boundary has to fall between rows of different kinds.
	var want []string
	for i := range 7 {
		at := base.Add(time.Duration(i) * time.Minute)
		if i%2 == 0 {
			want = append(want, dbfx.Comment(t, issue, "c", testutil.Cols{"workspace_id": ws, "created_at": at}))
		} else {
			want = append(want, dbfx.Insert(t, "activity_log", testutil.Cols{
				"workspace_id": ws, "issue_id": issue, "actor_type": "member", "actor_id": testUserID,
				"action": "status_changed", "created_at": at,
			}))
		}
	}
	tie := base.Add(3 * time.Minute)
	want = append(want, dbfx.Comment(t, issue, "tie", testutil.Cols{"workspace_id": ws, "created_at": tie}))

	var got []string
	cursor := ""
	for page := 0; ; page++ {
		if page > 10 {
			t.Fatal("paging did not terminate")
		}
		path := "/api/activity?limit=2"
		if cursor != "" {
			path += "&before=" + url.QueryEscape(cursor)
		}
		var out WorkspaceActivityResponse
		testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest(path, ws, testUserID)).
			Want(http.StatusOK).JSON(&out)
		for _, e := range out.Entries {
			got = append(got, e.ID)
		}
		if out.NextCursor == nil {
			break
		}
		cursor = *out.NextCursor
	}
	slices.Sort(want)
	sortedGot := slices.Clone(got)
	slices.Sort(sortedGot)
	if !slices.Equal(sortedGot, want) {
		t.Fatalf("paged entries = %v, want each of %v exactly once", got, want)
	}
	testutil.Call(t, testHandler.ListWorkspaceActivity, workspaceActivityRequest("/api/activity?before=nope", ws, testUserID)).
		Want(http.StatusBadRequest)
}

func TestListRecentlyCompletedIssuesPagesByOffset(t *testing.T) {
	ws := dbfx.Workspace(t, "Completed pages", "completed-pages-"+uuid.NewString(), testutil.Cols{"issue_prefix": "CP"})
	dbfx.Member(t, ws, testUserID, "owner")
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	for i := range 3 {
		dbfx.Issue(t, "Done", testutil.Cols{"workspace_id": ws, "status": "done", "updated_at": base.Add(time.Duration(i) * time.Minute)})
	}
	var first, second RecentlyCompletedResponse
	testutil.Call(t, testHandler.ListRecentlyCompletedIssues, workspaceActivityRequest("/api/activity/completed?category=done&limit=2", ws, testUserID)).
		Want(http.StatusOK).JSON(&first)
	if len(first.Entries) != 2 || first.NextOffset == nil || *first.NextOffset != 2 {
		t.Fatalf("first page = %+v", first)
	}
	testutil.Call(t, testHandler.ListRecentlyCompletedIssues, workspaceActivityRequest("/api/activity/completed?category=done&limit=2&offset=2", ws, testUserID)).
		Want(http.StatusOK).JSON(&second)
	if len(second.Entries) != 1 || second.NextOffset != nil {
		t.Fatalf("second page = %+v", second)
	}
}
