package handler

import (
	"net/http"
	"slices"

	"github.com/multica-ai/multica/server/internal/providerquota"
	"github.com/multica-ai/multica/server/internal/usagereport"
)

// providerQuotaResponse adds usage.report's reading of today's Claude limit
// to the sidecar's accounts.
type providerQuotaResponse struct {
	providerquota.Response
	ClaudeLimit *usagereport.Limit `json:"claude_limit"`
}

// GetProviderQuota serves the multica-quota sidecar's Claude/Codex usage for
// the sidebar. It is deployment-wide, not workspace-scoped. The tracker is
// asked only when a Claude account is listed, so a deployment without one
// makes no outbound call.
func (h *Handler) GetProviderQuota(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	resp := providerQuotaResponse{Response: h.ProviderQuota.Get(r.Context())}
	if slices.ContainsFunc(resp.Accounts, func(a providerquota.Account) bool { return a.Provider == "claude" }) {
		resp.ClaudeLimit = h.UsageReport.Get(r.Context())
	}
	writeJSON(w, http.StatusOK, resp)
}
