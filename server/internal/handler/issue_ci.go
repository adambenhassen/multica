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
// passed at its head commit: still running ("pending") or "failed".
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
		state := rollupToConclusion(p.ChecksRollupState, p.ChecksFailed, p.ChecksRunning, p.ChecksPassed)
		if state == nil || *state == "passed" {
			continue
		}
		// Check runs carry no timestamps; the PR's last update is the closest
		// stand-in for when CI at the current head started or failed.
		candidates = append(candidates, issueCICandidate{
			resp: IssueCIStateResponse{
				IssueID:     uuidToString(p.IssueID),
				IssueStatus: p.IssueStatus,
				State:       *state,
				PullRequest: IssueCIPullRequest{
					Provider: "github", RepoOwner: p.RepoOwner, RepoName: p.RepoName,
					Number: p.PrNumber, HTMLURL: p.HtmlUrl,
				},
			},
			since: p.PrUpdatedAt,
		})
	}
	for _, p := range vcsRows {
		state := aggregateChecksConclusion(p.ChecksFailed, p.ChecksPassed, p.ChecksPending, p.ChecksTotal)
		if state == nil || *state == "passed" {
			continue
		}
		since := p.PendingSince
		if *state == "failed" {
			since = p.FailedAt
		}
		candidates = append(candidates, issueCICandidate{
			resp: IssueCIStateResponse{
				IssueID:     uuidToString(p.IssueID),
				IssueStatus: p.IssueStatus,
				State:       *state,
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

// mergeIssueCIStates keeps one entry per issue. A failed PR outranks a pending
// one, as in aggregateChecksConclusion; within a state the earliest wins.
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
		return a.resp.State == "failed"
	}
	if !a.since.Valid {
		return false
	}
	return !b.since.Valid || a.since.Time.Before(b.since.Time)
}
