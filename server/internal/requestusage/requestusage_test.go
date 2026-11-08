package requestusage

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func newFixture(t *testing.T) (*testutil.Fixture, string) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL required; run through make env-exec")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)
	fx := testutil.New(pool, "", "")
	suffix := time.Now().UnixNano()
	fx.UserID = fx.User(t, "Request usage", fmt.Sprintf("request-usage-%d@multica.test", suffix))
	fx.WorkspaceID = fx.Workspace(t, "Request usage", fmt.Sprintf("request-usage-%d", suffix))
	fx.Member(t, fx.WorkspaceID, fx.UserID, "owner")
	runtimeID := fx.Runtime(t, "Request usage runtime")
	agentID := fx.Agent(t, "Request usage agent", runtimeID)
	taskID := fx.Task(t, agentID, testutil.Cols{"status": "running", "runtime_id": runtimeID})
	fx.Cleanup(t, `DELETE FROM task_request_usage WHERE task_id = $1`, taskID)
	return fx, taskID
}

func usageRow(t *testing.T, fx *testutil.Fixture, taskID, provider, model string, input, output, cacheRead, cacheWrite int64) {
	t.Helper()
	fx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, taskID, provider, model, input, output, cacheRead, cacheWrite)
}

func cost(t *testing.T, fx *testutil.Fixture, taskID, model string) *int64 {
	t.Helper()
	var ticks *int64
	fx.QueryRow(t, `SELECT cost_usd_ticks FROM task_usage WHERE task_id = $1 AND model = $2`, taskID, model).Scan(&ticks)
	return ticks
}

func requestCost(t *testing.T, model string, tokens metrics.RequestTokens) int64 {
	t.Helper()
	ticks, ok := metrics.RequestCostTicks(model, tokens)
	if !ok {
		t.Fatalf("%s unpriced", model)
	}
	return ticks
}

func TestRecordPricesTaskFromItsRequests(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	short := metrics.RequestTokens{Input: 2, Output: 400, CacheRead: 9403, CacheWrite1h: 14143}
	long := metrics.RequestTokens{Input: 5, Output: 900, CacheRead: 120_000, CacheWrite1h: 3000}
	// The daemon's totals for the same run: writes are one counter.
	usageRow(t, fx, taskID, "claude", "claude-haiku-5-5", 7, 1300, 129_403, 17_143)

	changed, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-haiku-5-5", Tokens: short},
		{Key: "req_2", Provider: "claude", Model: "claude-haiku-5-5", Tokens: long},
	})
	if err != nil || !changed {
		t.Fatalf("Record = %v, %v; want changed", changed, err)
	}
	want := requestCost(t, "claude-haiku-5-5", short) + requestCost(t, "claude-haiku-5-5", long)
	if got := cost(t, fx, taskID, "claude-haiku-5-5"); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRecordIgnoresRepeatedRequests(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5", 10, 500, 50_000, 3000)
	req := Request{Key: "req_1", Provider: "claude", Model: "claude-opus-5-5",
		Tokens: metrics.RequestTokens{Input: 10, Output: 500, CacheRead: 50_000, CacheWrite: 1000, CacheWrite1h: 2000}}

	for i := 0; i < 2; i++ {
		if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{req}); err != nil {
			t.Fatalf("Record #%d: %v", i+1, err)
		}
	}
	if n := fx.Count(t, `SELECT count(*) FROM task_request_usage WHERE task_id = $1`, taskID); n != 1 {
		t.Fatalf("stored requests = %d, want 1", n)
	}
	if got, want := cost(t, fx, taskID, "claude-opus-5-5"), requestCost(t, "claude-opus-5-5", req.Tokens); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRecordEstimatesTokensNoRequestCovers(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	// The run started before telemetry was on: the daemon totals include
	// usage no stored request covers. That remainder is priced at base rates.
	usageRow(t, fx, taskID, "codex", "gpt-6.1-sol", 2000, 3000, 400_000, 100)
	req := metrics.RequestTokens{Input: 1000, CacheRead: 300_000, Output: 2000}

	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "conv:1", Provider: "codex", Model: "gpt-6.1-sol", Tokens: req},
	}); err != nil {
		t.Fatal(err)
	}
	remainder, ok := metrics.UsageCostTicks("gpt-6.1-sol", 1000, 1000, 100_000, 100)
	if !ok {
		t.Fatal("gpt-6.1-sol unpriced")
	}
	want := requestCost(t, "gpt-6.1-sol", req) + remainder
	if got := cost(t, fx, taskID, "gpt-6.1-sol"); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRecordUsesRequestsWhenDaemonTotalsLag(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	// A 30-second daemon snapshot can trail the telemetry.
	usageRow(t, fx, taskID, "claude", "claude-sonnet-5-5", 1, 10, 1000, 0)
	req := metrics.RequestTokens{Input: 5, Output: 50, CacheRead: 4000, CacheWrite1h: 900}

	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-sonnet-5-5", Tokens: req},
	}); err != nil {
		t.Fatal(err)
	}
	if got, want := cost(t, fx, taskID, "claude-sonnet-5-5"), requestCost(t, "claude-sonnet-5-5", req); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRecordMatchesContextTaggedModelRow(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5[1m]", 3, 30, 300, 0)
	req := metrics.RequestTokens{Input: 3, Output: 30, CacheRead: 300}

	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-opus-5-5", Tokens: req},
	}); err != nil {
		t.Fatal(err)
	}
	if got, want := cost(t, fx, taskID, "claude-opus-5-5[1m]"), requestCost(t, "claude-opus-5-5", req); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRecordLeavesAmbiguousAndUncoveredRowsAlone(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	// Two rows spell the same model, so the requests cannot be split between
	// them; a third row has no requests at all.
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5", 1, 1, 1, 1)
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5[1m]", 1, 1, 1, 1)
	usageRow(t, fx, taskID, "claude", "claude-haiku-5-5", 1, 1, 1, 1)

	changed, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-opus-5-5", Tokens: metrics.RequestTokens{Input: 1}},
		// Unpriced requests are dropped rather than stored at $0.
		{Key: "req_2", Provider: "claude", Model: "claude-haiku-9-9", Tokens: metrics.RequestTokens{Input: 1}},
	})
	if err != nil || changed {
		t.Fatalf("Record = %v, %v; want unchanged", changed, err)
	}
	for _, model := range []string{"claude-opus-5-5", "claude-opus-5-5[1m]", "claude-haiku-5-5"} {
		if got := cost(t, fx, taskID, model); got != nil {
			t.Errorf("%s cost = %d, want NULL", model, *got)
		}
	}
	if n := fx.Count(t, `SELECT count(*) FROM task_request_usage WHERE task_id = $1`, taskID); n != 1 {
		t.Fatalf("stored requests = %d, want 1", n)
	}
}

func TestRefreshRestoresCostAfterDaemonOverwrite(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	usageRow(t, fx, taskID, "claude", "claude-haiku-5-5", 2, 4, 9403, 14143)
	req := metrics.RequestTokens{Input: 2, Output: 4, CacheRead: 9403, CacheWrite1h: 14143}
	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-haiku-5-5", Tokens: req},
	}); err != nil {
		t.Fatal(err)
	}
	// A daemon usage report rewrites the row with no cost of its own.
	fx.Exec(t, `UPDATE task_usage SET cost_usd_ticks = NULL WHERE task_id = $1`, taskID)

	changed, err := Refresh(ctx, fx.Pool, util.MustParseUUID(taskID))
	if err != nil || !changed {
		t.Fatalf("Refresh = %v, %v; want changed", changed, err)
	}
	if got, want := cost(t, fx, taskID, "claude-haiku-5-5"), requestCost(t, "claude-haiku-5-5", req); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestRefreshClearsCostWhenRowsBecomeAmbiguous(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5", 3, 30, 300, 0)
	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-opus-5-5", Tokens: metrics.RequestTokens{Input: 3, Output: 30, CacheRead: 300}},
	}); err != nil {
		t.Fatal(err)
	}
	// A second spelling of the model appears later; the requests can no
	// longer be split, so neither row may keep a cost built from all of them.
	usageRow(t, fx, taskID, "claude", "claude-opus-5-5[1m]", 1, 1, 1, 0)

	if _, err := Refresh(ctx, fx.Pool, util.MustParseUUID(taskID)); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"claude-opus-5-5", "claude-opus-5-5[1m]"} {
		if got := cost(t, fx, taskID, model); got != nil {
			t.Errorf("%s cost = %d, want NULL", model, *got)
		}
	}
}

func TestRecordStoresOneHourWritesAndRejectsImpossibleCounts(t *testing.T) {
	ctx := context.Background()
	fx, taskID := newFixture(t)
	usageRow(t, fx, taskID, "claude", "claude-haiku-5-5", 2, 4, 9403, 14143)

	if _, err := Record(ctx, fx.Pool, util.MustParseUUID(taskID), []Request{
		{Key: "req_1", Provider: "claude", Model: "claude-haiku-5-5", Tokens: metrics.RequestTokens{Input: 2, Output: 4, CacheRead: 9403, CacheWrite: 143, CacheWrite1h: 14000}},
		// No request carries billions of tokens; such a record is corrupt.
		{Key: "req_2", Provider: "claude", Model: "claude-haiku-5-5", Tokens: metrics.RequestTokens{Input: 1 << 50}},
	}); err != nil {
		t.Fatal(err)
	}
	var total, oneHour int64
	fx.QueryRow(t, `SELECT cache_write_tokens, cache_write_1h_tokens FROM task_request_usage WHERE task_id = $1 AND request_key = 'req_1'`, taskID).Scan(&total, &oneHour)
	if total != 14143 || oneHour != 14000 {
		t.Fatalf("stored writes = %d total, %d 1h; want 14143, 14000", total, oneHour)
	}
	if n := fx.Count(t, `SELECT count(*) FROM task_request_usage WHERE task_id = $1`, taskID); n != 1 {
		t.Fatalf("stored requests = %d, want 1", n)
	}
}
