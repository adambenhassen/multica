package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/providerquota"
	"github.com/multica-ai/multica/server/internal/usagereport"
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
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil || string(raw["claude_limit"]) != "null" {
		t.Fatalf("want claude_limit null, got %s", w.Body.String())
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

// quotaHandler serves one sidecar account of provider and a usage.report
// reading measured a minute ago, counting tracker hits.
func quotaHandler(t *testing.T, provider string) (*Handler, *atomic.Int32) {
	t.Helper()
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"accounts":[{"id":"%[1]s-main","provider":"%[1]s","label":"main","windows":[]}]}`, provider)
	}))
	t.Cleanup(sidecar.Close)
	var hits atomic.Int32
	measured := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)
	tracker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprintf(w, `{"current":{"level":"tight","efficiency":85,"last_measured":%q}}`, measured)
	}))
	t.Cleanup(tracker.Close)
	return &Handler{ProviderQuota: providerquota.New(sidecar.URL), UsageReport: usagereport.New(tracker.URL)}, &hits
}

func getProviderQuota(t *testing.T, h *Handler) map[string]json.RawMessage {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/provider-quota", nil)
	req.Header.Set("X-User-ID", testUserID)
	w := httptest.NewRecorder()
	h.GetProviderQuota(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

func TestGetProviderQuotaAddsClaudeLimitWhenAClaudeAccountIsListed(t *testing.T) {
	h, _ := quotaHandler(t, "claude")
	got := getProviderQuota(t, h)

	var limit usagereport.Limit
	if err := json.Unmarshal(got["claude_limit"], &limit); err != nil {
		t.Fatalf("decode claude_limit %s: %v", got["claude_limit"], err)
	}
	if limit.Level != "tight" || limit.Efficiency != 85 || limit.MeasuredAt.IsZero() {
		t.Fatalf("unexpected claude_limit: %s", got["claude_limit"])
	}
	var accounts []providerquota.Account
	if err := json.Unmarshal(got["accounts"], &accounts); err != nil || len(accounts) != 1 {
		t.Fatalf("want the sidecar account alongside, got %s", got["accounts"])
	}
}

func TestGetProviderQuotaSkipsTheTrackerWithoutAClaudeAccount(t *testing.T) {
	h, hits := quotaHandler(t, "codex")
	got := getProviderQuota(t, h)

	if string(got["claude_limit"]) != "null" {
		t.Fatalf("want claude_limit null, got %s", got["claude_limit"])
	}
	if hits.Load() != 0 {
		t.Fatalf("want no tracker call, got %d", hits.Load())
	}
}
