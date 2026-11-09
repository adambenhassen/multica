package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestOTLPRecordTime(t *testing.T) {
	str := func(key, v string) otlpKeyValue {
		var kv otlpKeyValue
		kv.Key = key
		kv.Value.StringValue = &v
		return kv
	}
	at := time.Date(2026, 11, 8, 10, 0, 0, 500_000_000, time.UTC)
	nanos := json.RawMessage(`"1794132000500000000"`)
	cases := []struct {
		name     string
		attrs    []otlpKeyValue
		time     json.RawMessage
		observed json.RawMessage
		want     time.Time
	}{
		{"event timestamp wins", []otlpKeyValue{str("event.timestamp", "2026-11-08T10:00:00.5Z")}, json.RawMessage(`"1"`), nil, at},
		{"record time", nil, nanos, nil, at},
		{"observed time when record time is unset", nil, json.RawMessage(`"0"`), json.RawMessage(`1794132000500000000`), at},
		{"nothing usable", []otlpKeyValue{str("event.timestamp", "yesterday")}, json.RawMessage(`null`), nil, time.Time{}},
	}
	for _, tc := range cases {
		if got := otlpRecordTime(newOTLPAttrs(tc.attrs), tc.time, tc.observed); !got.Equal(tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestIngestAgentTelemetryStoresRequestTime(t *testing.T) {
	taskID := newTelemetryTask(t, "claude telemetry time")
	h := *testHandler
	h.Bus = events.New()
	body := otlpLogs("claude-code", append(
		claudeAPIRequest("req_timed", "claude-haiku-5-5", 2, 400, 9403, 0, 14143),
		otlpString("event.timestamp", "2026-11-08T10:00:00.5Z"),
	))
	testutil.Call(t, h.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(taskID), body)).Want(http.StatusOK)

	var got time.Time
	if err := testPool.QueryRow(context.Background(),
		`SELECT requested_at FROM task_request_usage WHERE task_id = $1`, taskID,
	).Scan(&got); err != nil {
		t.Fatalf("read requested_at: %v", err)
	}
	if want := time.Date(2026, 11, 8, 10, 0, 0, 500_000_000, time.UTC); !got.Equal(want) {
		t.Fatalf("requested_at = %v, want %v", got, want)
	}
}

// A resumed run reports the context its first request on its main model
// reloaded. Cheaper side or subagent calls, a run whose first such request has
// no time, and runs that started fresh report nothing.
func TestHydrateTaskUsageCarriedOver(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	issueID := dbfx.Issue(t, "carried over fixture")
	agentID := dbfx.Agent(t, "carried over agent", testRuntimeID)
	task := func(session string, extra testutil.Cols) string {
		cols := testutil.Cols{"runtime_id": testRuntimeID, "status": "completed", "session_id": session}
		if extra == nil {
			cols["issue_id"] = issueID
		}
		for k, v := range extra {
			cols[k] = v
		}
		id := dbfx.Task(t, agentID, cols)
		dbfx.Cleanup(t, `DELETE FROM task_request_usage WHERE task_id = $1`, id)
		dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
			VALUES ($1, 'claude', 'claude-opus-5-5', 1, 1, 1, 1)`, id)
		return id
	}
	prior := task("carried-session", nil)
	dbfx.Exec(t, `UPDATE agent_task_queue SET created_at = now() - interval '3 hours' WHERE id = $1`, prior)
	resumed := task("carried-session", nil)
	partial := task("carried-session", nil)
	fresh := task("fresh-session", nil)
	chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"title": "carried over chat"})
	chatPrior := task("chat-session", testutil.Cols{"chat_session_id": chatID})
	dbfx.Exec(t, `UPDATE agent_task_queue SET created_at = now() - interval '2 hours' WHERE id = $1`, chatPrior)
	chatResumed := task("chat-session", testutil.Cols{"chat_session_id": chatID})

	request := func(taskID, key, model string, at any, cost, input, read, write int64) {
		dbfx.Exec(t, `INSERT INTO task_request_usage
			(task_id, request_key, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_ticks, requested_at)
			VALUES ($1, $2, 'claude', $3, $4, 10, $5, $6, $7, $8)`, taskID, key, model, input, read, write, cost, at)
	}
	t0 := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	// Many cheap calls come first, yet the opus conversation is the main model.
	for i, key := range []string{"side-1", "side-2", "side-3"} {
		request(resumed, key, "claude-haiku-5-5", t0.Add(time.Duration(i)*time.Millisecond), 1, 100, 0, 500)
	}
	request(resumed, "first", "claude-opus-5-5", t0.Add(time.Second), 50, 5, 1000, 236000)
	request(resumed, "second", "claude-opus-5-5", t0.Add(30*time.Second), 50, 3, 237000, 2000)
	request(partial, "untimed", "claude-opus-5-5", nil, 50, 5, 1000, 236000)
	request(partial, "timed", "claude-opus-5-5", t0, 50, 3, 237000, 2000)
	request(fresh, "only", "claude-opus-5-5", t0, 50, 5, 1000, 20000)
	request(chatResumed, "chat-first", "claude-opus-5-5", t0, 50, 2, 90000, 3000)

	resp := []AgentTaskResponse{{ID: resumed}, {ID: partial}, {ID: fresh}, {ID: prior}}
	testHandler.hydrateTaskUsage(ctx, parseUUID(issueID), resp)
	if got := resp[0].CarriedOver; got == nil || *got != (TaskCarriedOver{ContextTokens: 237005, UncachedTokens: 236005}) {
		t.Fatalf("resumed run carried_over = %+v, want context 237005, uncached 236005", got)
	}
	for i, name := range []string{"", "partly timed", "fresh", "first"} {
		if i > 0 && resp[i].CarriedOver != nil {
			t.Fatalf("%s run carried_over = %+v, want none", name, resp[i].CarriedOver)
		}
	}
	if len(resp[0].Usage) == 0 {
		t.Fatal("usage was not hydrated alongside carried_over")
	}

	// Agent history hydrates the same field, chats included.
	history := []AgentTaskResponse{{ID: chatResumed}, {ID: resumed}}
	if err := testHandler.hydrateAgentTaskUsage(ctx, parseUUID(agentID), []pgtype.UUID{parseUUID(chatResumed), parseUUID(resumed)}, history); err != nil {
		t.Fatalf("hydrate agent history: %v", err)
	}
	if got := history[0].CarriedOver; got == nil || *got != (TaskCarriedOver{ContextTokens: 93002, UncachedTokens: 3002}) {
		t.Fatalf("resumed chat carried_over = %+v, want context 93002, uncached 3002", got)
	}
	if history[1].CarriedOver == nil {
		t.Fatal("agent history lost the resumed issue run's carried_over")
	}
}
