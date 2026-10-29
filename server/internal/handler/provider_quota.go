package handler

import "net/http"

// GetProviderQuota serves the multica-quota sidecar's Claude/Codex usage for
// the sidebar. It is deployment-wide, not workspace-scoped.
func (h *Handler) GetProviderQuota(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, h.ProviderQuota.Get(r.Context()))
}
