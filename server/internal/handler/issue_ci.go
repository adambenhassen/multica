package handler

import (
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5/pgtype"
)

// IssueCIPullRequest names the pull request an issue's CI state comes from.
type IssueCIPullRequest struct {
	Provider  string `json:"provider"`
	RepoOwner string `json:"repo_owner"`
	RepoName  string `json:"repo_name"`
	Number    int32  `json:"number"`
	HTMLURL   string `json:"html_url"`
}

// IssueCIStateResponse is an issue whose open pull request has CI that has not
// passed at its head commit: "queued" (no check started yet), "running",
// "failing" (a check failed while others still run), or "failed" (every check
// finished, at least one failed); or whose CI is done but the merge gate still
// holds it ("gate").
type IssueCIStateResponse struct {
	IssueID     string             `json:"issue_id"`
	IssueStatus string             `json:"issue_status"`
	State       string             `json:"state"`
	Since       *string            `json:"since"`
	PullRequest IssueCIPullRequest `json:"pull_request"`
}

type issueCICandidate struct {
	resp  IssueCIStateResponse
	since pgtype.Timestamptz
}

// ListWorkspaceIssueCI backs the Activity page's Waiting tab: one entry per
// issue whose linked open PRs have CI pending or failed. Passed and
// check-less PRs are left out.
func (h *Handler) ListWorkspaceIssueCI(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	wsUUID := parseUUID(workspaceID)
	ghRows, err := h.Queries.ListOpenPullRequestChecksByWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue CI")
		return
	}
	vcsRows, err := h.Queries.ListOpenVCSPullRequestChecksByWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue CI")
		return
	}

	candidates := make([]issueCICandidate, 0, len(ghRows)+len(vcsRows))
	snapshotEnabled := h.PRRefresh.Enabled()
	for _, p := range ghRows {
		if !currentGitHubSnapshotAvailable(snapshotEnabled, p.HeadSha, p.SnapshotHeadSha, p.SnapshotFetchedAt) {
			continue
		}
		// Counted from the check runs, not the GraphQL rollup: the rollup folds
		// in the merge gate, which would keep a finished PR pending.
		state := issueCIState(p.ChecksFailed, p.ChecksRunning-p.ChecksQueued, p.ChecksQueued, p.GatePending)
		if state == "" {
			continue
		}
		// Check runs carry no timestamps, and the PR's last update moves on
		// every comment, so a GitHub state has no since.
		candidates = append(candidates, issueCICandidate{
			resp: IssueCIStateResponse{
				IssueID:     uuidToString(p.IssueID),
				IssueStatus: p.IssueStatus,
				State:       state,
				PullRequest: IssueCIPullRequest{
					Provider: "github", RepoOwner: p.RepoOwner, RepoName: p.RepoName,
					Number: p.PrNumber, HTMLURL: p.HtmlUrl,
				},
			},
		})
	}
	for _, p := range vcsRows {
		state := issueCIState(p.ChecksFailed, p.ChecksPending-p.ChecksQueued, p.ChecksQueued, p.GatePending)
		since := p.RunningSince
		switch state {
		case "":
			continue
		case "failed", "failing":
			since = p.FailedAt
		case "queued":
			since = p.QueuedSince
		case "gate":
			since = p.GateSince
		}
		candidates = append(candidates, issueCICandidate{
			resp: IssueCIStateResponse{
				IssueID:     uuidToString(p.IssueID),
				IssueStatus: p.IssueStatus,
				State:       state,
				PullRequest: IssueCIPullRequest{
					Provider: p.Provider, RepoOwner: p.RepoOwner, RepoName: p.RepoName,
					Number: p.PrNumber, HTMLURL: p.HtmlUrl,
				},
			},
			since: since,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"issues": mergeIssueCIStates(candidates)})
}

// issueCIState is a PR's Waiting-tab state from its CI counts (merge gate
// excluded) and pending merge-gate count: a failure is "failing" while other
// checks are unfinished and "failed" once all are done (the CI router reports
// a run only when it completes); unfinished checks are "running" once one has
// started, else "queued"; finished CI still held by the gate is "gate".
// Anything else gives "".
func issueCIState(failed, started, queued, gate int64) string {
	switch {
	case failed > 0 && started+queued > 0:
		return "failing"
	case failed > 0:
		return "failed"
	case started > 0:
		return "running"
	case queued > 0:
		return "queued"
	case gate > 0:
		return "gate"
	}
	return ""
}

// issueCIRank orders states for mergeIssueCIStates: a failed PR outranks a
// running one, as in aggregateChecksConclusion, a finished failure outranks one
// still running, running outranks queued, and any CI outranks the merge gate.
var issueCIRank = map[string]int{"failed": 4, "failing": 3, "running": 2, "queued": 1, "gate": 0}

// mergeIssueCIStates keeps one entry per issue: the highest-ranked state, then
// the earliest since.
func mergeIssueCIStates(in []issueCICandidate) []IssueCIStateResponse {
	best := make(map[string]issueCICandidate, len(in))
	for _, c := range in {
		cur, ok := best[c.resp.IssueID]
		if !ok || issueCIOutranks(c, cur) {
			best[c.resp.IssueID] = c
		}
	}
	out := make([]IssueCIStateResponse, 0, len(best))
	for _, c := range best {
		c.resp.Since = timestampToPtr(c.since)
		out = append(out, c.resp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IssueID < out[j].IssueID })
	return out
}

func issueCIOutranks(a, b issueCICandidate) bool {
	if a.resp.State != b.resp.State {
		return issueCIRank[a.resp.State] > issueCIRank[b.resp.State]
	}
	if !a.since.Valid {
		return false
	}
	return !b.since.Valid || a.since.Time.Before(b.since.Time)
}
