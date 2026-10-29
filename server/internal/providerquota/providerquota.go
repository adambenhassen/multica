// Package providerquota proxies the multica-quota sidecar, which polls
// Claude/Codex subscription usage for the accounts it is logged in to.
package providerquota

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	freshFor     = 60 * time.Second
	staleFor     = 10 * time.Minute
	fetchTimeout = 5 * time.Second
)

type Window struct {
	Kind        string  `json:"kind"`
	UsedPercent float64 `json:"used_percent"`
	ResetsAt    *string `json:"resets_at"`
}

type Account struct {
	ID        string   `json:"id"`
	Provider  string   `json:"provider"`
	Label     string   `json:"label"`
	Windows   []Window `json:"windows"`
	Error     *string  `json:"error"`
	UpdatedAt *string  `json:"updated_at"`
}

type Response struct {
	Accounts []Account `json:"accounts"`
}

type Client struct {
	url  string
	http *http.Client
	now  func() time.Time

	mu        sync.Mutex
	cached    *Response
	fetchedAt time.Time
}

// New returns nil when the sidecar is not configured; a nil *Client serves an
// empty list so the UI hides the panel.
func New(baseURL string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	return &Client{
		url:  baseURL + "/usage",
		http: &http.Client{Timeout: fetchTimeout},
		now:  time.Now,
	}
}

func (c *Client) Get(ctx context.Context) Response {
	if c == nil {
		return empty()
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	if c.cached != nil && now.Sub(c.fetchedAt) < freshFor {
		return *c.cached
	}
	resp, err := c.fetch(ctx)
	if err != nil {
		slog.Warn("provider quota: sidecar fetch failed", "error", err)
		if c.cached != nil && now.Sub(c.fetchedAt) < staleFor {
			return *c.cached
		}
		return empty()
	}
	c.cached = &resp
	c.fetchedAt = now
	return resp
}

func (c *Client) fetch(ctx context.Context) (Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return Response{}, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return Response{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Response{}, fmt.Errorf("status %d", res.StatusCode)
	}
	var out Response
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return Response{}, fmt.Errorf("decode: %w", err)
	}
	if out.Accounts == nil {
		out.Accounts = []Account{}
	}
	for i := range out.Accounts {
		if out.Accounts[i].Windows == nil {
			out.Accounts[i].Windows = []Window{}
		}
	}
	return out, nil
}

func empty() Response { return Response{Accounts: []Account{}} }
