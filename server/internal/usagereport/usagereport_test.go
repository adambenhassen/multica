package usagereport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

var measured = time.Date(2026, 11, 24, 18, 57, 0, 0, time.UTC)

func body(lastMeasured string) string {
	return fmt.Sprintf(`{"current":{"pp":12,"efficiency":85,"level":"tight",
 "verdict":"Your limit goes a bit less far today","last_measured":%q,"model":"claude-opus-5-5"},
 "stats":{"baseline_pp":9},"timeline":[{"t":"2026-10-25T03:58:00Z","pp":8,"efficiency":113}]}`, lastMeasured)
}

type tracker struct {
	status atomic.Int32
	hits   atomic.Int32
	body   atomic.Value
}

func newTracker(t *testing.T) (*tracker, *httptest.Server) {
	t.Helper()
	tr := &tracker{}
	tr.status.Store(http.StatusOK)
	tr.body.Store(body(measured.Format(time.RFC3339)))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tr.hits.Add(1)
		if r.URL.Path != "/api/burn-rate" {
			http.NotFound(w, r)
			return
		}
		if s := tr.status.Load(); s != http.StatusOK {
			w.WriteHeader(int(s))
			return
		}
		w.Write([]byte(tr.body.Load().(string)))
	}))
	t.Cleanup(srv.Close)
	return tr, srv
}

func newTestClient(url string, now *time.Time) *Client {
	c := New(url)
	c.now = func() time.Time { return *now }
	return c
}

func TestNilClientReportsNothing(t *testing.T) {
	var c *Client
	if got := c.Get(context.Background()); got != nil {
		t.Fatalf("want nil, got %#v", got)
	}
	if New("  ") != nil {
		t.Fatal("New with an empty URL must return nil")
	}
}

func TestGetDecodesCurrentReading(t *testing.T) {
	_, srv := newTracker(t)
	now := measured.Add(4 * time.Hour)
	got := newTestClient(srv.URL+"/", &now).Get(context.Background())
	want := Limit{Level: "tight", Efficiency: 85, MeasuredAt: measured}
	if got == nil || *got != want {
		t.Fatalf("want %#v, got %#v", want, got)
	}
}

func TestGetCachesForAnHour(t *testing.T) {
	tr, srv := newTracker(t)
	now := measured.Add(time.Minute)
	c := newTestClient(srv.URL, &now)

	c.Get(context.Background())
	now = now.Add(59 * time.Minute)
	c.Get(context.Background())
	if tr.hits.Load() != 1 {
		t.Fatalf("want 1 hit within an hour, got %d", tr.hits.Load())
	}
	now = now.Add(time.Minute)
	c.Get(context.Background())
	if tr.hits.Load() != 2 {
		t.Fatalf("want a refetch after an hour, got %d hits", tr.hits.Load())
	}
}

func TestGetWaitsFiveMinutesBeforeRetryingAFailure(t *testing.T) {
	tr, srv := newTracker(t)
	tr.status.Store(http.StatusBadGateway)
	now := measured.Add(time.Minute)
	c := newTestClient(srv.URL, &now)

	if got := c.Get(context.Background()); got != nil {
		t.Fatalf("want nil while the tracker fails, got %#v", got)
	}
	now = now.Add(4 * time.Minute)
	c.Get(context.Background())
	if tr.hits.Load() != 1 {
		t.Fatalf("want no retry within 5m, got %d hits", tr.hits.Load())
	}
	tr.status.Store(http.StatusOK)
	now = now.Add(time.Minute)
	if got := c.Get(context.Background()); got == nil || tr.hits.Load() != 2 {
		t.Fatalf("want a successful retry after 5m, got %#v after %d hits", got, tr.hits.Load())
	}
}

func TestGetKeepsTheLastReadingThroughFailuresUntilItIsTwelveHoursOld(t *testing.T) {
	tr, srv := newTracker(t)
	now := measured.Add(time.Hour)
	c := newTestClient(srv.URL, &now)
	c.Get(context.Background())

	tr.status.Store(http.StatusInternalServerError)
	now = measured.Add(12*time.Hour - time.Minute)
	if got := c.Get(context.Background()); got == nil {
		t.Fatal("want the cached reading while under 12h old")
	}
	now = measured.Add(12 * time.Hour)
	if got := c.Get(context.Background()); got != nil {
		t.Fatalf("want nil once the reading is 12h old, got %#v", got)
	}
}

func TestGetIgnoresAReadingTheTrackerStoppedUpdating(t *testing.T) {
	_, srv := newTracker(t)
	now := measured.Add(13 * time.Hour)
	if got := newTestClient(srv.URL, &now).Get(context.Background()); got != nil {
		t.Fatalf("want nil for a 13h-old reading, got %#v", got)
	}
}

func TestGetRejectsMalformedReadings(t *testing.T) {
	for name, payload := range map[string]string{
		"not json":          `<html>`,
		"no current":        `{"stats":{}}`,
		"no level":          `{"current":{"efficiency":85,"last_measured":"2026-11-24T18:57:00Z"}}`,
		"zero efficiency":   `{"current":{"level":"fair","efficiency":0,"last_measured":"2026-11-24T18:57:00Z"}}`,
		"bad measured time": body("yesterday"),
	} {
		t.Run(name, func(t *testing.T) {
			tr, srv := newTracker(t)
			tr.body.Store(payload)
			now := measured.Add(time.Hour)
			if got := newTestClient(srv.URL, &now).Get(context.Background()); got != nil {
				t.Fatalf("want nil, got %#v", got)
			}
		})
	}
}

func TestGetReportsNothingWhenTrackerUnreachable(t *testing.T) {
	now := measured
	if got := newTestClient("http://127.0.0.1:1", &now).Get(context.Background()); got != nil {
		t.Fatalf("want nil, got %#v", got)
	}
}
