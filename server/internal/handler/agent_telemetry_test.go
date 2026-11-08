package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type otlpAttr = map[string]any

func otlpString(key, v string) otlpAttr {
	return otlpAttr{"key": key, "value": map[string]any{"stringValue": v}}
}

// Claude Code sends ints as JSON numbers, Codex as strings; both are valid OTLP JSON.
func otlpInt(key string, v any) otlpAttr {
	return otlpAttr{"key": key, "value": map[string]any{"intValue": v}}
}

func otlpLogs(service string, records ...[]otlpAttr) []byte {
	logRecords := make([]map[string]any, 0, len(records))
	for i, attrs := range records {
		logRecords = append(logRecords, map[string]any{
			"timeUnixNano":         "0",
			"observedTimeUnixNano": json.Number(strings.Repeat("1", 18) + string(rune('0'+i))),
			"attributes":           attrs,
		})
	}
	body, _ := json.Marshal(map[string]any{"resourceLogs": []any{map[string]any{
		"resource":  map[string]any{"attributes": []otlpAttr{otlpString("service.name", service)}},
		"scopeLogs": []any{map[string]any{"logRecords": logRecords}},
	}}})
	return body
}

func claudeAPIRequest(requestID, model string, input, output, cacheRead, write5m, write1h int64) []otlpAttr {
	return []otlpAttr{
		otlpString("user.email", "someone@example.com"),
		otlpString("event.name", "api_request"),
		otlpString("request_id", requestID),
		otlpString("model", model),
		otlpInt("input_tokens", input),
		otlpInt("output_tokens", output),
		otlpInt("cache_read_tokens", cacheRead),
		otlpInt("cache_creation_tokens", write5m+write1h),
		otlpInt("cache_creation_5m_tokens", write5m),
		otlpInt("cache_creation_1h_tokens", write1h),
		{"key": "cost_usd", "value": map[string]any{"doubleValue": 0.5}},
	}
}

func telemetryRequest(token string, body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/otlp/v1/logs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func newTelemetryTask(t *testing.T, name string) string {
	t.Helper()
	issueID := dbfx.Issue(t, name)
	agentID := dbfx.Agent(t, name+" agent", testRuntimeID)
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": testRuntimeID, "status": "running"})
	dbfx.Cleanup(t, `DELETE FROM task_request_usage WHERE task_id = $1`, taskID)
	return taskID
}

func taskUsageCost(t *testing.T, taskID, model string) *int64 {
	t.Helper()
	var ticks *int64
	dbfx.QueryRow(t, `SELECT cost_usd_ticks FROM task_usage WHERE task_id = $1 AND model = $2`, taskID, model).Scan(&ticks)
	return ticks
}

func mustRequestCost(t *testing.T, model string, tokens metrics.RequestTokens) int64 {
	t.Helper()
	ticks, ok := metrics.RequestCostTicks(model, tokens)
	if !ok {
		t.Fatalf("%s unpriced", model)
	}
	return ticks
}

func TestIngestAgentTelemetryPricesClaudeCodeRequests(t *testing.T) {
	taskID := newTelemetryTask(t, "claude telemetry")
	dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
		VALUES ($1, 'claude', 'claude-haiku-5-5', 7, 1300, 129403, 17143)`, taskID)
	h := *testHandler
	h.Bus = events.New()
	var updates []events.Event
	h.Bus.Subscribe(protocol.EventTaskUsage, func(e events.Event) { updates = append(updates, e) })

	body := otlpLogs("claude-code",
		[]otlpAttr{otlpString("event.name", "hook_execution_start")},
		claudeAPIRequest("req_short", "claude-haiku-5-5", 2, 400, 9403, 0, 14143),
		claudeAPIRequest("req_long", "claude-haiku-5-5", 5, 900, 120_000, 0, 3000),
	)
	testutil.Call(t, h.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(taskID), body)).Want(http.StatusOK)

	want := mustRequestCost(t, "claude-haiku-5-5", metrics.RequestTokens{Input: 2, Output: 400, CacheRead: 9403, CacheWrite1h: 14143}) +
		mustRequestCost(t, "claude-haiku-5-5", metrics.RequestTokens{Input: 5, Output: 900, CacheRead: 120_000, CacheWrite1h: 3000})
	if got := taskUsageCost(t, taskID, "claude-haiku-5-5"); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
	if len(updates) != 1 || updates[0].TaskID != taskID {
		t.Fatalf("usage updates = %+v, want one for task %s", updates, taskID)
	}
	// A retried batch is stored once and changes nothing.
	testutil.Call(t, h.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(taskID), body)).Want(http.StatusOK)
	if n := dbfx.Count(t, `SELECT count(*) FROM task_request_usage WHERE task_id = $1`, taskID); n != 2 {
		t.Fatalf("stored requests = %d, want 2", n)
	}
	if len(updates) != 1 {
		t.Fatalf("retry published %d more updates", len(updates)-1)
	}
}

func TestIngestAgentTelemetryPricesCodexRequests(t *testing.T) {
	taskID := newTelemetryTask(t, "codex telemetry")
	dbfx.Exec(t, `INSERT INTO task_usage (task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
		VALUES ($1, 'codex', 'gpt-6.1-sol', 1000, 2000, 300000, 500)`, taskID)
	h := *testHandler
	h.Bus = events.New()

	completed := func(input, cached, written, output string) []otlpAttr {
		return []otlpAttr{
			otlpString("event.name", "codex.sse_event"),
			otlpString("event.kind", "response.completed"),
			otlpString("conversation.id", "01a1ba9c-d88f-70b0-b36e-5b17621ce0c1"),
			otlpString("model", "gpt-6.1-sol"),
			otlpString("input_token_count", input),
			otlpString("output_token_count", output),
			otlpInt("cached_token_count", cached),
			otlpInt("cache_write_token_count", written),
			otlpInt("reasoning_token_count", "0"),
		}
	}
	body := otlpLogs("codex-app-server",
		[]otlpAttr{otlpString("event.name", "codex.sse_event"), otlpString("event.kind", "response.created")},
		completed("301500", "300000", "500", "2000"),
	)
	testutil.Call(t, h.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(taskID), body)).Want(http.StatusOK)

	// Codex input includes cached and written tokens; the stored split does not.
	want := mustRequestCost(t, "gpt-6.1-sol", metrics.RequestTokens{Input: 1000, CacheRead: 300_000, CacheWrite: 500, Output: 2000})
	if got := taskUsageCost(t, taskID, "gpt-6.1-sol"); got == nil || *got != want {
		t.Fatalf("cost = %v, want %d", got, want)
	}
}

func TestIngestAgentTelemetryRejectsBadRequests(t *testing.T) {
	taskID := newTelemetryTask(t, "telemetry auth")
	body := otlpLogs("claude-code", claudeAPIRequest("req_1", "claude-haiku-5-5", 1, 1, 1, 1, 0))
	token := signAgentTelemetryToken(taskID)

	testutil.Call(t, testHandler.IngestAgentTelemetry, telemetryRequest("", body)).Want(http.StatusUnauthorized)
	forged := signAgentTelemetryToken(uuid.NewString())
	forged = taskID + forged[strings.IndexByte(forged, '.'):]
	testutil.Call(t, testHandler.IngestAgentTelemetry, telemetryRequest(forged, body)).Want(http.StatusUnauthorized)

	protobuf := telemetryRequest(token, body)
	protobuf.Header.Set("Content-Type", "application/x-protobuf")
	testutil.Call(t, testHandler.IngestAgentTelemetry, protobuf).Want(http.StatusUnsupportedMediaType)
	testutil.Call(t, testHandler.IngestAgentTelemetry, telemetryRequest(token, []byte("{"))).Want(http.StatusBadRequest)
	testutil.Call(t, testHandler.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(uuid.NewString()), body)).Want(http.StatusNotFound)

	if n := dbfx.Count(t, `SELECT count(*) FROM task_request_usage WHERE task_id = $1`, taskID); n != 0 {
		t.Fatalf("rejected requests stored %d rows", n)
	}
}

func TestReportTaskUsageKeepsRequestPricedCost(t *testing.T) {
	taskID := newTelemetryTask(t, "telemetry then daemon report")
	h := *testHandler
	h.Bus = events.New()
	body := otlpLogs("claude-code", claudeAPIRequest("req_1", "claude-opus-5-5", 10, 500, 50_000, 1000, 2000))
	testutil.Call(t, h.IngestAgentTelemetry, telemetryRequest(signAgentTelemetryToken(taskID), body)).Want(http.StatusOK)

	// The daemon's report carries no cost; it must not erase the priced one.
	entry := TaskUsagePayload{Provider: "claude", Model: "claude-opus-5-5", InputTokens: 10, OutputTokens: 500,
		CacheReadTokens: 50_000, CacheWriteTokens: 3000}
	req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/api/daemon/tasks/"+taskID+"/usage",
		map[string]any{"usage": []TaskUsagePayload{entry}}), "taskId", taskID)
	testutil.Call(t, h.ReportTaskUsage, req).Want(http.StatusOK)

	want := mustRequestCost(t, "claude-opus-5-5", metrics.RequestTokens{Input: 10, Output: 500, CacheRead: 50_000, CacheWrite: 1000, CacheWrite1h: 2000})
	if got := taskUsageCost(t, taskID, "claude-opus-5-5"); got == nil || *got != want {
		t.Fatalf("cost after daemon report = %v, want %d", got, want)
	}
	rows, err := h.Queries.GetTaskUsage(context.Background(), parseUUID(taskID))
	if err != nil || len(rows) != 1 {
		t.Fatalf("usage rows = %v, err=%v", rows, err)
	}
}

func TestAgentTelemetryLaunch(t *testing.T) {
	const base = "https://multica.example:8080"
	taskID := uuid.NewString()
	endpoint := base + agentTelemetryPath
	auth := "Authorization=Bearer " + signAgentTelemetryToken(taskID)

	env, args := agentTelemetryLaunch(base, "claude", taskID, map[string]string{"KEEP": "1"}, []string{"--flag"})
	wantEnv := map[string]string{
		"KEEP":                             "1",
		"CLAUDE_CODE_ENABLE_TELEMETRY":     "1",
		"OTEL_LOGS_EXPORTER":               "otlp",
		"OTEL_METRICS_EXPORTER":            "none",
		"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": endpoint,
		"OTEL_EXPORTER_OTLP_HEADERS":       auth,
	}
	if !reflect.DeepEqual(env, wantEnv) || !reflect.DeepEqual(args, []string{"--flag"}) {
		t.Fatalf("claude launch = %v %v; want %v [--flag]", env, args, wantEnv)
	}

	env, args = agentTelemetryLaunch(base, "codex", taskID, nil, []string{"--flag"})
	wantArgs := []string{"--flag",
		"-c", `otel.exporter={otlp-http={endpoint="` + endpoint + `",protocol="json"}}`,
	}
	if !reflect.DeepEqual(env, map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": auth}) || !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("codex launch = %v %v; want token env and %v", env, args, wantArgs)
	}

	unchanged := []struct {
		name, base, provider string
		env                  map[string]string
		args                 []string
	}{
		{name: "not configured", base: "", provider: "claude"},
		{name: "other provider", base: base, provider: "opencode"},
		{name: "own claude telemetry", base: base, provider: "claude", env: map[string]string{"otel_exporter_otlp_endpoint": "http://mine"}},
		{name: "claude telemetry flag set", base: base, provider: "claude", env: map[string]string{"CLAUDE_CODE_ENABLE_TELEMETRY": "0"}},
		{name: "own codex otel config", base: base, provider: "codex", args: []string{"-c", "otel.exporter=\"none\""}},
	}
	for _, tc := range unchanged {
		env, args := agentTelemetryLaunch(tc.base, tc.provider, taskID, tc.env, tc.args)
		if !reflect.DeepEqual(env, tc.env) || !reflect.DeepEqual(args, tc.args) {
			t.Errorf("%s: launch = %v %v; want unchanged %v %v", tc.name, env, args, tc.env, tc.args)
		}
	}
}

func TestClaim_PointsClaudeCodeTelemetryAtServer(t *testing.T) {
	ctx := context.Background()
	runtimeID := dbfx.Runtime(t, "Telemetry claim runtime", testutil.Cols{"provider": "claude"})
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, "Telemetry claim agent")
	taskID := createDispatchedClaimFixtureTask(t, ctx, agentID, runtimeID, issueID, "120 seconds", false)
	h := *testHandler
	h.cfg.AgentTelemetryURL = "https://multica.example:8080"

	req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil), "runtimeId", runtimeID)
	var resp struct {
		Task *struct {
			ID    string `json:"id"`
			Agent *struct {
				CustomEnv map[string]string `json:"custom_env"`
			} `json:"agent"`
		} `json:"task"`
	}
	testutil.Call(t, h.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&resp)
	if resp.Task == nil || resp.Task.ID != taskID || resp.Task.Agent == nil {
		t.Fatalf("claimed %+v; want task %s with agent data", resp.Task, taskID)
	}
	env := resp.Task.Agent.CustomEnv
	if env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] != "https://multica.example:8080"+agentTelemetryPath {
		t.Fatalf("telemetry endpoint = %q", env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"])
	}
	token := strings.TrimPrefix(env["OTEL_EXPORTER_OTLP_HEADERS"], "Authorization=Bearer ")
	if got, ok := verifyAgentTelemetryToken(token); !ok || got != taskID {
		t.Fatalf("telemetry token authenticates task %q (ok=%v); want %s", got, ok, taskID)
	}
}
