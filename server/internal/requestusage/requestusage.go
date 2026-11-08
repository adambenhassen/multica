// Package requestusage stores per-request model usage for a task and prices
// the task's usage rows from it.
//
// Daemons report usage per task as running totals, which cannot show a
// request's prompt size or cache-write lifetime, so long-prompt tiers and
// Anthropic 1-hour writes are invisible to them. Agent CLIs report each request
// separately through their own telemetry (and Claude Code transcripts keep the
// same records), so a task's cost is the sum of its priced requests, plus a
// base-rate estimate for any reported tokens no stored request covers.
package requestusage

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Request is one model API request's usage.
type Request struct {
	// Key identifies the request within its task, so a repeated delivery is
	// stored once: the provider's request id, or a stable substitute.
	Key string
	// Provider and Model use task_usage's spelling ("claude", "codex").
	Provider string
	Model    string
	Tokens   metrics.RequestTokens
}

// TxStarter begins the transaction that stores requests and reprices rows.
type TxStarter interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Record stores the task's priced requests and reprices its usage rows in one
// transaction. Requests for unpriced models are dropped. It reports whether
// any row's cost changed.
func Record(ctx context.Context, conn TxStarter, taskID pgtype.UUID, reqs []Request) (bool, error) {
	return inTx(ctx, conn, func(q *db.Queries) (bool, error) {
		for _, r := range reqs {
			ticks, ok := metrics.RequestCostTicks(r.Model, r.Tokens)
			if !ok {
				continue
			}
			if _, err := q.InsertTaskRequestUsage(ctx, db.InsertTaskRequestUsageParams{
				TaskID:           taskID,
				RequestKey:       r.Key,
				Provider:         r.Provider,
				Model:            r.Model,
				InputTokens:      r.Tokens.Input,
				OutputTokens:     r.Tokens.Output,
				CacheReadTokens:  r.Tokens.CacheRead,
				CacheWriteTokens: r.Tokens.CacheWrite + r.Tokens.CacheWrite1h,
				CostUsdTicks:     ticks,
			}); err != nil {
				return false, fmt.Errorf("insert request usage: %w", err)
			}
		}
		return refresh(ctx, q, taskID)
	})
}

// Refresh reprices the task's usage rows from its stored requests. Call it
// after anything rewrites task_usage, such as a daemon usage report.
func Refresh(ctx context.Context, conn TxStarter, taskID pgtype.UUID) (bool, error) {
	return inTx(ctx, conn, func(q *db.Queries) (bool, error) {
		return refresh(ctx, q, taskID)
	})
}

func inTx(ctx context.Context, conn TxStarter, fn func(*db.Queries) (bool, error)) (bool, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	changed, err := fn(db.New(tx))
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return changed, nil
}

type rowKey struct{ provider, model string }

func refresh(ctx context.Context, q *db.Queries, taskID pgtype.UUID) (bool, error) {
	rows, err := q.LockTaskUsageRows(ctx, taskID)
	if err != nil {
		return false, fmt.Errorf("lock usage rows: %w", err)
	}
	if len(rows) == 0 {
		return false, nil
	}
	sums, err := q.SumTaskRequestUsage(ctx, taskID)
	if err != nil {
		return false, fmt.Errorf("sum request usage: %w", err)
	}
	if len(sums) == 0 {
		return false, nil
	}
	byKey := make(map[rowKey]db.SumTaskRequestUsageRow, len(sums))
	for _, s := range sums {
		k := rowKey{s.Provider, normalizeModel(s.Model)}
		acc := byKey[k]
		acc.InputTokens += s.InputTokens
		acc.OutputTokens += s.OutputTokens
		acc.CacheReadTokens += s.CacheReadTokens
		acc.CacheWriteTokens += s.CacheWriteTokens
		acc.CostUsdTicks += s.CostUsdTicks
		byKey[k] = acc
	}
	rowsPerKey := make(map[rowKey]int, len(rows))
	for _, r := range rows {
		rowsPerKey[rowKey{r.Provider, normalizeModel(r.Model)}]++
	}

	changed := false
	for _, r := range rows {
		k := rowKey{r.Provider, normalizeModel(r.Model)}
		sum, ok := byKey[k]
		// Two rows spelling one model cannot split the requests between them.
		if !ok || rowsPerKey[k] > 1 {
			continue
		}
		ticks := sum.CostUsdTicks
		remainder := [4]int64{
			r.InputTokens - sum.InputTokens,
			r.OutputTokens - sum.OutputTokens,
			r.CacheReadTokens - sum.CacheReadTokens,
			r.CacheWriteTokens - sum.CacheWriteTokens,
		}
		for i := range remainder {
			remainder[i] = max(remainder[i], 0)
		}
		if remainder != [4]int64{} {
			est, ok := metrics.UsageCostTicks(r.Model, remainder[0], remainder[1], remainder[2], remainder[3])
			if !ok {
				continue
			}
			ticks += est
		}
		if ticks <= 0 {
			continue
		}
		n, err := q.SetTaskUsageCost(ctx, db.SetTaskUsageCostParams{
			ID:           r.ID,
			CostUsdTicks: pgtype.Int8{Int64: ticks, Valid: true},
		})
		if err != nil {
			return false, fmt.Errorf("set usage cost: %w", err)
		}
		changed = changed || n > 0
	}
	return changed, nil
}

var contextTagRe = regexp.MustCompile(`\[[^\]]*\]$`)

// normalizeModel matches a usage row to its requests: Claude Code can key its
// totals by `claude-opus-5-5[1m]` while each request names `claude-opus-5-5`.
func normalizeModel(model string) string {
	return contextTagRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(model)), "")
}
