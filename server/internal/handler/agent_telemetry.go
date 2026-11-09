package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/requestusage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Agent CLIs export one OpenTelemetry log event per model API request (Claude
// Code's api_request, Codex's codex.sse_event response.completed). The claim
// response points their OTLP/HTTP JSON log exporter here with a per-task
// token, so a task's cost is priced request by request; see requestusage.

const agentTelemetryPath = "/api/otlp/v1/logs"

// A batch holds at most a few hundred records of a few KB each.
const agentTelemetryMaxBodyBytes = 8 << 20

const agentTelemetryKeyDomain = "agent-telemetry-ingest:"

var (
	agentTelemetryKeyOnce sync.Once
	agentTelemetryKey     []byte
)

// agentTelemetrySigningKey is derived from JWT_SECRET under its own domain,
// so these tokens can never collide with another signature the server mints.
func agentTelemetrySigningKey() []byte {
	agentTelemetryKeyOnce.Do(func() {
		sum := sha256.Sum256(append([]byte(agentTelemetryKeyDomain), auth.JWTSecret()...))
		agentTelemetryKey = sum[:]
	})
	return agentTelemetryKey
}

// signAgentTelemetryToken returns "<task id>.<signature>". It has no expiry:
// exports can arrive after the task ends, and the token only lets its holder
// add request usage to that one task.
func signAgentTelemetryToken(taskID string) string {
	mac := hmac.New(sha256.New, agentTelemetrySigningKey())
	mac.Write([]byte(taskID))
	return taskID + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func verifyAgentTelemetryToken(token string) (string, bool) {
	taskID, rawSig, ok := strings.Cut(token, ".")
	if !ok {
		return "", false
	}
	if _, err := util.ParseUUID(taskID); err != nil {
		return "", false
	}
	got, err := base64.RawURLEncoding.DecodeString(rawSig)
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, agentTelemetrySigningKey())
	mac.Write([]byte(taskID))
	return taskID, hmac.Equal(got, mac.Sum(nil))
}

// IngestAgentTelemetry — POST /api/otlp/v1/logs
//
// A public route: the bearer token is the credential. Only request-usage
// events are read; every other record and attribute (prompts, user identity)
// is ignored and never stored.
func (h *Handler) IngestAgentTelemetry(w http.ResponseWriter, r *http.Request) {
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	taskID, ok := verifyAgentTelemetryToken(strings.TrimSpace(token))
	if !strings.EqualFold(scheme, "Bearer") || !ok {
		writeError(w, http.StatusUnauthorized, "invalid telemetry token")
		return
	}
	if mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "only OTLP/HTTP JSON is accepted")
		return
	}
	var payload otlpLogsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, agentTelemetryMaxBodyBytes)).Decode(&payload); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "telemetry batch too large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid OTLP JSON")
		return
	}
	task, err := h.Queries.GetAgentTask(r.Context(), parseUUID(taskID))
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		slog.Warn("telemetry: load task failed", "task_id", taskID, "error", err)
		// 503, not 500: OTLP exporters retry only 429, 502, 503 and 504.
		writeError(w, http.StatusServiceUnavailable, "failed to load task")
		return
	}

	reqs := payload.requests()
	if len(reqs) > 0 {
		changed, err := requestusage.Record(r.Context(), h.TxStarter, task.ID, reqs)
		if err != nil {
			slog.Warn("telemetry: record request usage failed", "task_id", taskID, "error", err)
			writeError(w, http.StatusServiceUnavailable, "failed to record usage")
			return
		}
		if changed {
			h.publishTaskUsageUpdated(r, task)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// publishTaskUsageUpdated tells clients to refetch the task's usage.
func (h *Handler) publishTaskUsageUpdated(r *http.Request, task db.AgentTaskQueue) {
	scope, err := h.TaskService.ResolveTaskScopeChecked(r.Context(), task)
	if err != nil || scope.WorkspaceID == "" {
		slog.Warn("telemetry: resolve task workspace failed", "task_id", uuidToString(task.ID), "error", err)
		return
	}
	h.Bus.Publish(events.Event{
		Type:        protocol.EventTaskUsage,
		WorkspaceID: scope.WorkspaceID,
		ActorType:   "system",
		TaskID:      uuidToString(task.ID),
		Payload:     protocol.TaskUsageUpdatedPayload{TaskID: uuidToString(task.ID)},
	})
}

// otlpLogsRequest is the part of an OTLP ExportLogsServiceRequest (JSON
// encoding) that carries request usage.
type otlpLogsRequest struct {
	ResourceLogs []struct {
		ScopeLogs []struct {
			LogRecords []struct {
				TimeUnixNano         json.RawMessage `json:"timeUnixNano"`
				ObservedTimeUnixNano json.RawMessage `json:"observedTimeUnixNano"`
				Attributes           []otlpKeyValue  `json:"attributes"`
			} `json:"logRecords"`
		} `json:"scopeLogs"`
	} `json:"resourceLogs"`
}

type otlpKeyValue struct {
	Key   string `json:"key"`
	Value struct {
		StringValue *string `json:"stringValue"`
		// int64 is a JSON string in canonical OTLP JSON; some exporters
		// (Claude Code's) send a number.
		IntValue    json.RawMessage `json:"intValue"`
		DoubleValue *float64        `json:"doubleValue"`
	} `json:"value"`
}

type otlpAttrs map[string]otlpKeyValue

func newOTLPAttrs(kvs []otlpKeyValue) otlpAttrs {
	attrs := make(otlpAttrs, len(kvs))
	for _, kv := range kvs {
		attrs[kv.Key] = kv
	}
	return attrs
}

func (a otlpAttrs) str(key string) string {
	if v := a[key].Value.StringValue; v != nil {
		return *v
	}
	return ""
}

// int reads a non-negative count, whichever OTLP value type carries it.
func (a otlpAttrs) int(key string) int64 {
	v := a[key].Value
	var n int64
	switch {
	case len(v.IntValue) > 0:
		n, _ = strconv.ParseInt(strings.Trim(string(v.IntValue), `"`), 10, 64)
	case v.StringValue != nil:
		n, _ = strconv.ParseInt(*v.StringValue, 10, 64)
	case v.DoubleValue != nil:
		// Out-of-range floats have no defined int64 conversion.
		if d := *v.DoubleValue; d >= 0 && d < math.MaxInt32 {
			n = int64(d)
		}
	}
	return max(n, 0)
}

func (p otlpLogsRequest) requests() []requestusage.Request {
	var reqs []requestusage.Request
	for _, rl := range p.ResourceLogs {
		for _, sl := range rl.ScopeLogs {
			for _, rec := range sl.LogRecords {
				attrs := newOTLPAttrs(rec.Attributes)
				var req requestusage.Request
				var ok bool
				switch {
				// Matched by event name alone: a daemon host can rename the
				// resource (OTEL_SERVICE_NAME), and the token already scopes
				// the batch to one task.
				case attrs.str("event.name") == "api_request":
					req, ok = claudeCodeRequest(attrs)
				case attrs.str("event.name") == "codex.sse_event" && attrs.str("event.kind") == "response.completed":
					req, ok = codexRequest(attrs, strings.Trim(string(rec.ObservedTimeUnixNano), `"`))
				}
				if ok {
					req.At = otlpRecordTime(attrs, rec.TimeUnixNano, rec.ObservedTimeUnixNano)
					reqs = append(reqs, req)
				}
			}
		}
	}
	return reqs
}

// otlpRecordTime is when a usage event happened: the event's own timestamp
// attribute, else the record's time fields. Zero when none parses.
func otlpRecordTime(a otlpAttrs, timeNano, observedNano json.RawMessage) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, a.str("event.timestamp")); err == nil {
		return t
	}
	for _, raw := range []json.RawMessage{timeNano, observedNano} {
		if n, err := strconv.ParseInt(strings.Trim(string(raw), `"`), 10, 64); err == nil && n > 0 {
			return time.Unix(0, n).UTC()
		}
	}
	return time.Time{}
}

func claudeCodeRequest(a otlpAttrs) (requestusage.Request, bool) {
	key := a.str("request_id")
	if key == "" {
		key = a.str("client_request_id")
	}
	model := a.str("model")
	if key == "" || model == "" {
		return requestusage.Request{}, false
	}
	tokens := metrics.RequestTokens{
		Input:        a.int("input_tokens"),
		Output:       a.int("output_tokens"),
		CacheRead:    a.int("cache_read_tokens"),
		CacheWrite:   a.int("cache_creation_5m_tokens"),
		CacheWrite1h: a.int("cache_creation_1h_tokens"),
	}
	// Both lifetimes are 0 when the API did not split them.
	if tokens.CacheWrite+tokens.CacheWrite1h == 0 {
		tokens.CacheWrite = a.int("cache_creation_tokens")
	}
	return requestusage.Request{Key: key, Provider: "claude", Model: model, Tokens: tokens}, true
}

// codexRequest maps a response.completed event. Codex events carry no request
// id; the conversation plus the record's observed time identifies one, and a
// retried batch resends both unchanged.
func codexRequest(a otlpAttrs, observed string) (requestusage.Request, bool) {
	conversation := a.str("conversation.id")
	if observed == "" || observed == "0" || observed == "null" {
		observed = a.str("event.timestamp")
	}
	model := a.str("model")
	if conversation == "" || observed == "" || model == "" {
		return requestusage.Request{}, false
	}
	cached := a.int("cached_token_count")
	written := a.int("cache_write_token_count")
	return requestusage.Request{
		Key:      "codex:" + conversation + ":" + observed,
		Provider: "codex",
		Model:    model,
		Tokens: metrics.RequestTokens{
			// Codex input includes cached and written tokens; output
			// includes reasoning.
			Input:      max(a.int("input_token_count")-cached-written, 0),
			Output:     a.int("output_token_count"),
			CacheRead:  cached,
			CacheWrite: written,
		},
	}, true
}

// agentTelemetryLaunch adds the env and CLI args that make the task's agent CLI
// export per-request usage here. A task whose agent already configures its
// own telemetry is left alone: an exporter has a single destination.
func agentTelemetryLaunch(baseURL, provider, taskID string, env map[string]string, args []string) (map[string]string, []string) {
	if baseURL == "" {
		return env, args
	}
	endpoint := baseURL + agentTelemetryPath
	auth := "Authorization=Bearer " + signAgentTelemetryToken(taskID)
	switch provider {
	case "claude":
		for key := range env {
			upper := strings.ToUpper(key)
			if strings.HasPrefix(upper, "OTEL_") || upper == "CLAUDE_CODE_ENABLE_TELEMETRY" {
				return env, args
			}
		}
		out := make(map[string]string, len(env)+6)
		for k, v := range env {
			out[k] = v
		}
		out["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
		out["OTEL_LOGS_EXPORTER"] = "otlp"
		out["OTEL_METRICS_EXPORTER"] = "none"
		out["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"] = "http/json"
		out["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] = endpoint
		out["OTEL_EXPORTER_OTLP_HEADERS"] = auth
		return out, args
	case "codex":
		// Codex reads exporter settings only from config, so they ride as
		// `-c` overrides; the token stays in env, out of logged argv.
		if codexArgsConfigureOtel(args) {
			return env, args
		}
		out := make(map[string]string, len(env)+1)
		for k, v := range env {
			out[k] = v
		}
		out["OTEL_EXPORTER_OTLP_HEADERS"] = auth
		return out, append(slices.Clip(args),
			"-c", `otel.exporter={otlp-http={endpoint="`+endpoint+`",protocol="json"}}`,
		)
	}
	return env, args
}

// codexArgsConfigureOtel reports whether the agent's own args already set a
// Codex `otel.*` config key.
func codexArgsConfigureOtel(args []string) bool {
	for i, arg := range args {
		var value string
		switch {
		case (arg == "-c" || arg == "--config") && i+1 < len(args):
			value = args[i+1]
		case strings.HasPrefix(arg, "-c="):
			value = strings.TrimPrefix(arg, "-c=")
		case strings.HasPrefix(arg, "--config="):
			value = strings.TrimPrefix(arg, "--config=")
		default:
			continue
		}
		if strings.HasPrefix(strings.Trim(value, `"'`), "otel.") {
			return true
		}
	}
	return false
}
