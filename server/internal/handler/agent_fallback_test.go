package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func putFallbacks(t *testing.T, agentID string, body any) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID+"/fallbacks", body), "id", agentID)
	return testutil.Call(t, testHandler.ReplaceAgentFallbacks, req)
}

func TestReplaceAgentFallbacks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbacks", []byte("[]"))
	codex := dbfx.Runtime(t, "Fallback codex", testutil.Cols{"provider": "codex", "visibility": "public"})
	local := dbfx.Runtime(t, "Fallback local", testutil.Cols{"provider": "opencode", "visibility": "public"})

	var saved []AgentFallbackResponse
	putFallbacks(t, agentID, map[string]any{"fallbacks": []map[string]any{
		{"runtime_id": codex, "model": " gpt-5.6-terra ", "thinking_level": "xhigh"},
		{"runtime_id": local, "model": "local-qwen", "thinking_level": ""},
	}}).Want(http.StatusOK).JSON(&saved)
	if len(saved) != 2 || saved[0].Position != 1 || saved[0].Model != "gpt-5.6-terra" || saved[1].Position != 2 || saved[1].ThinkingLevel != "" {
		t.Fatalf("saved = %+v, want two trimmed entries at positions 1 and 2", saved)
	}

	var listed []AgentFallbackResponse
	req := withURLParam(newRequest(http.MethodGet, "/api/agents/"+agentID+"/fallbacks", nil), "id", agentID)
	testutil.Call(t, testHandler.ListAgentFallbacks, req).Want(http.StatusOK).JSON(&listed)
	if len(listed) != 2 || listed[0].RuntimeID != codex {
		t.Fatalf("listed = %+v, want the saved order", listed)
	}

	putFallbacks(t, agentID, map[string]any{"fallbacks": []map[string]any{}}).Want(http.StatusOK)
	testutil.Call(t, testHandler.ListAgentFallbacks, req).Want(http.StatusOK).JSON(&listed)
	if len(listed) != 0 {
		t.Fatalf("listed after clear = %+v, want none", listed)
	}
}

func TestReplaceAgentFallbacksRejectsInvalidLists(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbacksInvalid", []byte("[]"))
	codex := dbfx.Runtime(t, "Fallback invalid codex", testutil.Cols{"provider": "codex", "visibility": "public"})
	dbfx.Exec(t, `UPDATE agent SET model = 'agent-own-model' WHERE id = $1`, agentID)
	// Codex accepts any well-formed effort token (its catalog is checked on the
	// daemon), so the unknown-effort case needs a fixed-enum provider.
	claude := dbfx.Runtime(t, "Fallback invalid claude", testutil.Cols{"provider": "claude", "visibility": "public"})
	otherOwner := dbfx.User(t, "fallback-other-owner", "fallback-other-owner@example.com")
	foreignPrivate := dbfx.Runtime(t, "Fallback foreign private", testutil.Cols{"provider": "codex", "owner_id": otherOwner})

	entry := func(runtimeID, model, level string) map[string]any {
		return map[string]any{"runtime_id": runtimeID, "model": model, "thinking_level": level}
	}
	tests := []struct {
		name       string
		fallbacks  []map[string]any
		wantStatus int
		wantError  string
	}{
		{"empty model", []map[string]any{entry(codex, " ", "")}, http.StatusBadRequest, "model is required"},
		{"duplicate pair", []map[string]any{entry(codex, "gpt-5.6-terra", ""), entry(codex, "gpt-5.6-terra", "")}, http.StatusBadRequest, "duplicates"},
		{"duplicates the agent's own pair", []map[string]any{entry(handlerTestRuntimeID(t), "agent-own-model", "")}, http.StatusBadRequest, "duplicates"},
		{"too many", []map[string]any{entry(codex, "a", ""), entry(codex, "b", ""), entry(codex, "c", ""), entry(codex, "d", ""), entry(codex, "e", "")}, http.StatusBadRequest, "at most 4"},
		{"unknown effort", []map[string]any{entry(claude, "claude-opus-5-5", "bogus")}, http.StatusBadRequest, "thinking_level"},
		{"someone else's private runtime", []map[string]any{entry(foreignPrivate, "gpt-5.6-terra", "")}, http.StatusForbidden, "private"},
		{"unknown runtime", []map[string]any{entry("00000000-0000-0000-0000-000000000001", "gpt-5.6-terra", "")}, http.StatusBadRequest, "runtime_id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := putFallbacks(t, agentID, map[string]any{"fallbacks": tt.fallbacks}).Want(tt.wantStatus)
			if !strings.Contains(w.Body.String(), tt.wantError) {
				t.Fatalf("error = %s, want it to mention %q", w.Body.String(), tt.wantError)
			}
		})
	}
}

func TestListAgentTasksReturnsFallbackFields(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbackTaskFields", []byte("[]"))
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": handlerTestRuntimeID(t), "status": "completed",
		"model": "gpt-5.6-terra", "fallback_position": 2,
	})
	req := withURLParam(newRequest(http.MethodGet, "/api/agents/"+agentID+"/tasks", nil), "id", agentID)
	var resp []map[string]any
	testutil.Call(t, testHandler.ListAgentTasks, req).Want(http.StatusOK).JSON(&resp)
	for _, task := range resp {
		if task["id"] == taskID {
			if task["model"] != "gpt-5.6-terra" || task["fallback_position"] != float64(2) {
				t.Fatalf("task = %+v, want model and fallback_position", task)
			}
			return
		}
	}
	t.Fatalf("task %s missing from %+v", taskID, resp)
}
