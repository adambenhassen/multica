package providerquota

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const sample = `{"accounts":[{"id":"claude-personal","provider":"claude","label":"personal",
 "windows":[{"kind":"session","used_percent":42,"resets_at":"2026-10-29T14:10:00Z"}],
 "error":null,"updated_at":"2026-10-29T12:00:00Z","token":"must-not-pass"}]}`

func sidecar(t *testing.T, status *atomic.Int32, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/usage" {
			http.NotFound(w, r)
			return
		}
		if s := status.Load(); s != http.StatusOK {
			w.WriteHeader(int(s))
			return
		}
		w.Write([]byte(sample))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestClient(url string, now *time.Time) *Client {
	c := New(url)
	c.now = func() time.Time { return *now }
	return c
}

func TestNilClientReturnsEmptyList(t *testing.T) {
	var c *Client
	got := c.Get(context.Background())
	if got.Accounts == nil || len(got.Accounts) != 0 {
		t.Fatalf("want empty non-nil accounts, got %#v", got.Accounts)
	}
	if New("") != nil {
		t.Fatal("New(\"\") must return nil")
	}
}

func TestGetDecodesOnlyDocumentedFields(t *testing.T) {
	var status, hits atomic.Int32
	status.Store(http.StatusOK)
	srv := sidecar(t, &status, &hits)
	now := time.Now()
	got := newTestClient(srv.URL, &now).Get(context.Background())

	if len(got.Accounts) != 1 || got.Accounts[0].ID != "claude-personal" {
		t.Fatalf("unexpected accounts: %#v", got.Accounts)
	}
	w := got.Accounts[0].Windows[0]
	if w.Kind != "session" || w.UsedPercent != 42 || w.ResetsAt == nil || *w.ResetsAt != "2026-10-29T14:10:00Z" {
		t.Fatalf("unexpected window: %#v", w)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}
	var generic map[string][]map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatalf("decode re-encoded: %v", err)
	}
	if _, leaked := generic["accounts"][0]["token"]; leaked {
		t.Fatal("undocumented field passed through")
	}
}

func TestGetCachesForSixtySeconds(t *testing.T) {
	var status, hits atomic.Int32
	status.Store(http.StatusOK)
	srv := sidecar(t, &status, &hits)
	now := time.Now()
	c := newTestClient(srv.URL, &now)

	c.Get(context.Background())
	now = now.Add(59 * time.Second)
	c.Get(context.Background())
	if hits.Load() != 1 {
		t.Fatalf("want 1 sidecar hit within 60s, got %d", hits.Load())
	}
	now = now.Add(2 * time.Second)
	c.Get(context.Background())
	if hits.Load() != 2 {
		t.Fatalf("want refetch after 60s, got %d hits", hits.Load())
	}
}

func TestGetServesStaleCacheOnErrorUpToTenMinutes(t *testing.T) {
	var status, hits atomic.Int32
	status.Store(http.StatusOK)
	srv := sidecar(t, &status, &hits)
	now := time.Now()
	c := newTestClient(srv.URL, &now)
	c.Get(context.Background())

	status.Store(http.StatusInternalServerError)
	now = now.Add(5 * time.Minute)
	if got := c.Get(context.Background()); len(got.Accounts) != 1 {
		t.Fatalf("want stale cache within 10m, got %#v", got.Accounts)
	}
	now = now.Add(6 * time.Minute)
	if got := c.Get(context.Background()); len(got.Accounts) != 0 {
		t.Fatalf("want empty list after 10m of errors, got %#v", got.Accounts)
	}
}

func TestGetReturnsEmptyListWhenSidecarDown(t *testing.T) {
	now := time.Now()
	c := newTestClient("http://127.0.0.1:1", &now)
	if got := c.Get(context.Background()); got.Accounts == nil || len(got.Accounts) != 0 {
		t.Fatalf("want empty list, got %#v", got.Accounts)
	}
}

func TestGetReturnsEmptyListForMalformedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"accounts":"nope"}`))
	}))
	t.Cleanup(srv.Close)
	now := time.Now()
	if got := newTestClient(srv.URL, &now).Get(context.Background()); len(got.Accounts) != 0 {
		t.Fatalf("want empty list, got %#v", got.Accounts)
	}
}
