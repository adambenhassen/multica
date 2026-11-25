// Package usagereport reads usage.report, an independent tracker that
// measures how far a percent of the Claude subscription quota goes today
// compared with a usual day.
package usagereport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// DefaultURL is the tracker's public site; its API lives under /api.
const DefaultURL = "https://usage.report"

const (
	// The tracker measures about every 5h and serves its API with a 4h max-age.
	freshFor = time.Hour
	// Without this, an unreachable tracker would add a full timeout to every
	// quota poll.
	retryAfter = 5 * time.Minute
	// Two missed measurements: the reading no longer describes today.
	maxAge       = 12 * time.Hour
	fetchTimeout = 5 * time.Second
	maxBodyBytes = 1 << 20
)

// Limit is the tracker's latest measurement. Efficiency is the percent of a
// usual day's reach (100 = typical); Level is the tracker's band for it.
type Limit struct {
	Level      string    `json:"level"`
	Efficiency float64   `json:"efficiency"`
	MeasuredAt time.Time `json:"measured_at"`
}

type Client struct {
	url  string
	http *http.Client
	now  func() time.Time

	mu        sync.Mutex
	cached    *Limit
	fetchedAt time.Time
	triedAt   time.Time
}

// New returns nil for an empty baseURL; a nil *Client reports no reading.
func New(baseURL string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	return &Client{
		url:  baseURL + "/api/burn-rate",
		http: &http.Client{Timeout: fetchTimeout},
		now:  time.Now,
	}
}

// Get returns the latest reading, or nil when there is none younger than
// maxAge.
func (c *Client) Get(ctx context.Context) *Limit {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	stale := c.cached == nil || now.Sub(c.fetchedAt) >= freshFor
	if stale && now.Sub(c.triedAt) >= retryAfter {
		c.triedAt = now
		limit, err := c.fetch(ctx)
		if err != nil {
			slog.Warn("usage report: fetch failed", "error", err)
		} else {
			c.cached, c.fetchedAt = limit, now
		}
	}
	if c.cached == nil || now.Sub(c.cached.MeasuredAt) >= maxAge {
		return nil
	}
	limit := *c.cached
	return &limit
}

func (c *Client) fetch(ctx context.Context) (*Limit, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	var body struct {
		Current struct {
			Level        string  `json:"level"`
			Efficiency   float64 `json:"efficiency"`
			LastMeasured string  `json:"last_measured"`
		} `json:"current"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBodyBytes)).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	cur := body.Current
	if cur.Level == "" || cur.Efficiency <= 0 {
		return nil, errors.New("missing level or efficiency")
	}
	measuredAt, err := time.Parse(time.RFC3339, cur.LastMeasured)
	if err != nil {
		return nil, fmt.Errorf("last_measured: %w", err)
	}
	return &Limit{Level: cur.Level, Efficiency: cur.Efficiency, MeasuredAt: measuredAt}, nil
}
