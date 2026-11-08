// Backfill_claude_request_usage prices past Claude Code runs request by
// request from Claude Code's own transcripts, the same way live telemetry
// prices new runs (see internal/requestusage).
//
// Transcripts hold conversation text, so the work is split in two:
//
//	extract DIR      run where the transcripts are (the daemon's
//	                 CLAUDE_CONFIG_DIR/projects); writes token counts only,
//	                 one JSON object per request, to stdout
//	load FILE        run with DATABASE_URL; matches each request to its task by
//	                 session id and time, then stores and prices it
//
// load is a dry run unless --execute is passed. Tasks that already have
// per-request rows (live telemetry, or an earlier load) are skipped, so a
// request can never be counted under two different keys. Claude Code deletes
// transcripts after cleanupPeriodDays (30 by default); older runs keep their
// estimates.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/requestusage"
	"github.com/multica-ai/multica/server/internal/util"
)

// transcriptRequest is one request's usage as extract writes it.
type transcriptRequest struct {
	SessionID    string    `json:"session_id"`
	Key          string    `json:"key"`
	Time         time.Time `json:"time"`
	Model        string    `json:"model"`
	Input        int64     `json:"input"`
	Output       int64     `json:"output"`
	CacheRead    int64     `json:"cache_read"`
	CacheWrite5m int64     `json:"cache_write_5m"`
	CacheWrite1h int64     `json:"cache_write_1h"`
}

func (r transcriptRequest) tokens() metrics.RequestTokens {
	return metrics.RequestTokens{Input: r.Input, Output: r.Output, CacheRead: r.CacheRead, CacheWrite: r.CacheWrite5m, CacheWrite1h: r.CacheWrite1h}
}

func main() {
	logger.Init()
	if err := run(os.Args[1:]); err != nil {
		slog.Error("claude request usage backfill failed", "error", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		return errors.New("usage: backfill_claude_request_usage extract DIR | load [--execute] FILE")
	}
	switch args[0] {
	case "extract":
		reqs, err := extractRequests(args[1])
		if err != nil {
			return err
		}
		enc := json.NewEncoder(os.Stdout)
		for _, r := range reqs {
			if err := enc.Encode(r); err != nil {
				return err
			}
		}
		slog.Info("extracted requests", "count", len(reqs))
		return nil
	case "load":
		flags := flag.NewFlagSet("load", flag.ContinueOnError)
		execute := flags.Bool("execute", false, "store and price the requests; without it only print what would change")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 {
			return errors.New("load takes one extract file")
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return load(ctx, flags.Arg(0), *execute)
	}
	return fmt.Errorf("unknown command %q", args[0])
}

// extractRequests reads every transcript under dir. A request is streamed as
// several entries and a worktree resume can copy a whole transcript, so each
// (session, request) is kept once, from its last entry.
func extractRequests(dir string) ([]transcriptRequest, error) {
	type key struct{ session, request string }
	seen := map[key]transcriptRequest{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		return readTranscript(path, func(r transcriptRequest) {
			k := key{r.SessionID, r.Key}
			if prev, ok := seen[k]; !ok || !r.Time.Before(prev.Time) {
				seen[k] = r
			}
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]transcriptRequest, 0, len(seen))
	for _, r := range seen {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out, nil
}

type transcriptEntry struct {
	Type      string    `json:"type"`
	SessionID string    `json:"sessionId"`
	RequestID *string   `json:"requestId"`
	Timestamp time.Time `json:"timestamp"`
	Message   struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheCreation            struct {
				Ephemeral5m int64 `json:"ephemeral_5m_input_tokens"`
				Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

var usageMarker = []byte(`"usage"`)

func readTranscript(path string, emit func(transcriptRequest)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	rd := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, usageMarker) {
			var e transcriptEntry
			if json.Unmarshal(line, &e) == nil && e.Type == "assistant" && e.Message.Usage != nil && e.SessionID != "" {
				key := e.Message.ID
				if e.RequestID != nil && *e.RequestID != "" {
					key = *e.RequestID
				}
				if key != "" {
					u := e.Message.Usage
					r := transcriptRequest{
						SessionID: e.SessionID, Key: key, Time: e.Timestamp, Model: e.Message.Model,
						Input: u.InputTokens, Output: u.OutputTokens, CacheRead: u.CacheReadInputTokens,
						CacheWrite5m: u.CacheCreation.Ephemeral5m, CacheWrite1h: u.CacheCreation.Ephemeral1h,
					}
					if r.CacheWrite5m+r.CacheWrite1h == 0 {
						r.CacheWrite5m = u.CacheCreationInputTokens
					}
					emit(r)
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
	}
}

// taskWindow is when a task ran and which Claude sessions it used. A zero End
// means it has not finished.
type taskWindow struct {
	ID       string
	Sessions []string
	Start    time.Time
	End      time.Time
}

// assignRequests gives each request to the task that ran its session at that
// time; a resumed session spans several tasks with disjoint windows.
func assignRequests(reqs []transcriptRequest, tasks []taskWindow, slack time.Duration) (map[string][]transcriptRequest, int) {
	bySession := map[string][]taskWindow{}
	for _, t := range tasks {
		for _, s := range t.Sessions {
			if s != "" {
				bySession[s] = append(bySession[s], t)
			}
		}
	}
	out := map[string][]transcriptRequest{}
	unmatched := 0
	for _, r := range reqs {
		var best *taskWindow
		for i, t := range bySession[r.SessionID] {
			if r.Time.Before(t.Start.Add(-slack)) || (!t.End.IsZero() && r.Time.After(t.End.Add(slack))) {
				continue
			}
			if best == nil || t.Start.After(best.Start) {
				best = &bySession[r.SessionID][i]
			}
		}
		if best == nil {
			unmatched++
			continue
		}
		out[best.ID] = append(out[best.ID], r)
	}
	return out, unmatched
}

func readExtract(path string) ([]transcriptRequest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var reqs []transcriptRequest
	dec := json.NewDecoder(f)
	for {
		var r transcriptRequest
		if err := dec.Decode(&r); errors.Is(err, io.EOF) {
			return reqs, nil
		} else if err != nil {
			return nil, fmt.Errorf("read extract: %w", err)
		}
		reqs = append(reqs, r)
	}
}

func load(ctx context.Context, path string, execute bool) error {
	reqs, err := readExtract(path)
	if err != nil {
		return err
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return errors.New("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()

	sessions := map[string]bool{}
	for _, r := range reqs {
		sessions[r.SessionID] = true
	}
	ids := make([]string, 0, len(sessions))
	for s := range sessions {
		ids = append(ids, s)
	}
	rows, err := pool.Query(ctx, `
		SELECT t.id::text, COALESCE(t.session_id, ''), COALESCE(t.retired_session_id, ''),
		       COALESCE(t.started_at, t.dispatched_at, t.created_at), t.completed_at
		FROM agent_task_queue t
		WHERE (t.session_id = ANY($1) OR t.retired_session_id = ANY($1))
		  AND NOT EXISTS (SELECT 1 FROM task_request_usage r WHERE r.task_id = t.id)`, ids)
	if err != nil {
		return fmt.Errorf("load tasks: %w", err)
	}
	var tasks []taskWindow
	for rows.Next() {
		var t taskWindow
		var session, retired string
		var end *time.Time
		if err := rows.Scan(&t.ID, &session, &retired, &t.Start, &end); err != nil {
			rows.Close()
			return fmt.Errorf("scan task: %w", err)
		}
		t.Sessions = []string{session, retired}
		if end != nil {
			t.End = *end
		}
		tasks = append(tasks, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("load tasks: %w", err)
	}

	byTask, unmatched := assignRequests(reqs, tasks, 2*time.Minute)
	var exact int64
	priced := 0
	for _, rs := range byTask {
		for _, r := range rs {
			if ticks, ok := metrics.RequestCostTicks(r.Model, r.tokens()); ok {
				exact += ticks
				priced++
			}
		}
	}
	slog.Info("backfill plan", "requests", len(reqs), "tasks", len(byTask), "priced_requests", priced,
		"unmatched_requests", unmatched, "exact_usd", float64(exact)/metrics.CostUSDTicksPerUSD, "execute", execute)
	if !execute {
		return nil
	}
	repriced := 0
	for taskID, rs := range byTask {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch := make([]requestusage.Request, 0, len(rs))
		for _, r := range rs {
			batch = append(batch, requestusage.Request{Key: r.Key, Provider: "claude", Model: r.Model, Tokens: r.tokens()})
		}
		changed, err := requestusage.Record(ctx, pool, util.MustParseUUID(taskID), batch)
		if err != nil {
			return fmt.Errorf("task %s: %w", taskID, err)
		}
		if changed {
			repriced++
		}
	}
	slog.Info("backfill done", "tasks_repriced", repriced)
	return nil
}
