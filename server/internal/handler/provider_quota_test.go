package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/providerquota"
)

func TestGetProviderQuotaUnconfiguredReturnsEmptyList(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodGet, "/api/provider-quota", nil)
	req.Header.Set("X-User-ID", testUserID)
	w := httptest.NewRecorder()
	h.GetProviderQuota(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var got providerquota.Response
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Accounts == nil || len(got.Accounts) != 0 {
		t.Fatalf("want empty accounts, got %s", w.Body.String())
	}
}

func TestGetProviderQuotaRequiresUser(t *testing.T) {
	h := &Handler{}
	w := httptest.NewRecorder()
	h.GetProviderQuota(w, httptest.NewRequest(http.MethodGet, "/api/provider-quota", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
}
