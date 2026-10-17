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
		{"missing fallbacks field", nil, http.StatusBadRequest, "fallbacks is required"},
		{"unknown runtime", []map[string]any{entry("00000000-0000-0000-0000-000000000001", "gpt-5.6-terra", "")}, http.StatusBadRequest, "runtime_id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := map[string]any{}
			if tt.fallbacks != nil {
				body["fallbacks"] = tt.fallbacks
			}
			w := putFallbacks(t, agentID, body).Want(tt.wantStatus)
			if !strings.Contains(w.Body.String(), tt.wantError) {
				t.Fatalf("error = %s, want it to mention %q", w.Body.String(), tt.wantError)
			}
		})
	}
}

func TestReplaceAgentFallbacksRejectsOwnerlessRuntime(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbacksOwnerless", []byte("[]"))
	ownerless := dbfx.Runtime(t, "Fallback ownerless", testutil.Cols{"provider": "codex", "visibility": "public", "owner_id": nil})
	w := putFallbacks(t, agentID, map[string]any{"fallbacks": []map[string]any{
		{"runtime_id": ownerless, "model": "gpt-5.6-terra", "thinking_level": ""},
	}}).Want(http.StatusForbidden)
	if !strings.Contains(w.Body.String(), "no owner") {
		t.Fatalf("error = %s, want the ownerless-runtime message", w.Body.String())
	}
}

func TestReplaceAgentFallbacksRejectsNullFallbacks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbacksNull", []byte("[]"))
	w := putFallbacks(t, agentID, map[string]any{"fallbacks": nil}).Want(http.StatusBadRequest)
	if !strings.Contains(w.Body.String(), "fallbacks is required") {
		t.Fatalf("error = %s, want it to mention fallbacks is required", w.Body.String())
	}
}

func putFallbacksAs(t *testing.T, userID, agentID string, fallbacks []map[string]any) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequestAs(userID, http.MethodPut, "/api/agents/"+agentID+"/fallbacks", map[string]any{"fallbacks": fallbacks}), "id", agentID)
	return testutil.Call(t, testHandler.ReplaceAgentFallbacks, req)
}

func fallbackEntry(runtimeID string) []map[string]any {
	return []map[string]any{{"runtime_id": runtimeID, "model": "gpt-5.6-terra", "thinking_level": ""}}
}

func TestReplaceAgentFallbacksAuthorization(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	// createHandlerTestAgent agents are owned by testUserID, a workspace owner.
	agentID := createHandlerTestAgent(t, "AgentFallbacksAuthz", []byte("[]"))
	member := dbfx.User(t, "fallback-authz-member", "fallback-authz-member@example.com")
	dbfx.Member(t, testWorkspaceID, member, "member")

	t.Run("non-owner member cannot replace", func(t *testing.T) {
		pub := dbfx.Runtime(t, "Fallback authz public", testutil.Cols{"provider": "codex", "visibility": "public"})
		putFallbacksAs(t, member, agentID, fallbackEntry(pub)).Want(http.StatusForbidden)
	})

	t.Run("agent actor cannot replace", func(t *testing.T) {
		pub := dbfx.Runtime(t, "Fallback authz agent public", testutil.Cols{"provider": "codex", "visibility": "public"})
		caller := createHandlerTestAgent(t, "AgentFallbacksCaller", nil)
		taskID := insertHandlerTestTask(t, caller)
		req := withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID+"/fallbacks", map[string]any{"fallbacks": fallbackEntry(pub)}), "id", agentID)
		req.Header.Set("X-Actor-Source", "task_token")
		req.Header.Set("X-Agent-ID", caller)
		req.Header.Set("X-Task-ID", taskID)
		testutil.Call(t, testHandler.ReplaceAgentFallbacks, req).Want(http.StatusForbidden)
	})

	t.Run("runtime from another workspace", func(t *testing.T) {
		otherWS := dbfx.Workspace(t, "Fallback other workspace", "fallback-other-ws")
		foreign := dbfx.Runtime(t, "Fallback foreign workspace", testutil.Cols{"workspace_id": otherWS, "provider": "codex", "visibility": "public"})
		putFallbacks(t, agentID, map[string]any{"fallbacks": fallbackEntry(foreign)}).Want(http.StatusBadRequest)
	})

	t.Run("private runtime of the agent's owner is accepted", func(t *testing.T) {
		own := dbfx.Runtime(t, "Fallback owner private", testutil.Cols{"provider": "codex", "visibility": "private"})
		putFallbacks(t, agentID, map[string]any{"fallbacks": fallbackEntry(own)}).Want(http.StatusOK)
	})

	t.Run("admin cannot lend their private runtime to another member's agent", func(t *testing.T) {
		memberAgent := dbfx.Agent(t, "AgentFallbacksMemberOwned", handlerTestRuntimeID(t), testutil.Cols{"owner_id": member})
		adminPrivate := dbfx.Runtime(t, "Fallback admin private", testutil.Cols{"provider": "codex", "visibility": "private"})
		w := putFallbacks(t, memberAgent, map[string]any{"fallbacks": fallbackEntry(adminPrivate)}).Want(http.StatusForbidden)
		if !strings.Contains(w.Body.String(), "private") {
			t.Fatalf("error = %s, want it to mention private", w.Body.String())
		}
	})
}

func TestListAgentFallbacksPrivateAgentAccess(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID, ownerID, memberID := privateAgentTestFixture(t)
	get := func(userID string) *testutil.Response {
		req := withURLParam(newRequestAs(userID, http.MethodGet, "/api/agents/"+agentID+"/fallbacks", nil), "id", agentID)
		return testutil.Call(t, testHandler.ListAgentFallbacks, req)
	}
	get(memberID).Want(http.StatusForbidden)
	get(ownerID).Want(http.StatusOK)
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
	primaryID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	req := withURLParam(newRequest(http.MethodGet, "/api/agents/"+agentID+"/tasks", nil), "id", agentID)
	var resp []map[string]any
	testutil.Call(t, testHandler.ListAgentTasks, req).Want(http.StatusOK).JSON(&resp)
	for _, task := range resp {
		if task["id"] == primaryID {
			if _, ok := task["model"]; ok {
				t.Fatalf("primary task = %+v, want model omitted", task)
			}
			if _, ok := task["fallback_position"]; ok {
				t.Fatalf("primary task = %+v, want fallback_position omitted", task)
			}
		}
	}
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

// TestReplaceAgentFallbacksCancelsStrandedRuns: a queued fallback run whose
// entry the new list changed can never be claimed, so the replace cancels it;
// a run whose entry is unchanged stays queued.
func TestReplaceAgentFallbacksCancelsStrandedRuns(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "AgentFallbacksStranded", []byte("[]"))
	codex := dbfx.Runtime(t, "Fallback stranded codex", testutil.Cols{"provider": "codex", "visibility": "public"})
	local := dbfx.Runtime(t, "Fallback stranded local", testutil.Cols{"provider": "opencode", "visibility": "public"})
	putFallbacks(t, agentID, map[string]any{"fallbacks": []map[string]any{
		{"runtime_id": codex, "model": "gpt-5.6-terra"},
		{"runtime_id": local, "model": "local-qwen"},
	}}).Want(http.StatusOK)

	kept := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": codex, "issue_id": dbfx.Issue(t, "Stranded kept"),
		"model": "gpt-5.6-terra", "fallback_position": 1,
	})
	stranded := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": local, "issue_id": dbfx.Issue(t, "Stranded changed"),
		"model": "local-qwen", "fallback_position": 2,
	})

	putFallbacks(t, agentID, map[string]any{"fallbacks": []map[string]any{
		{"runtime_id": codex, "model": "gpt-5.6-terra"},
		{"runtime_id": local, "model": "local-llama"},
	}}).Want(http.StatusOK)

	status := func(taskID string) (string, string) {
		var s, by string
		dbfx.QueryRow(t, `SELECT status, COALESCE(cancelled_by_type, '') FROM agent_task_queue WHERE id = $1`, taskID).Scan(&s, &by)
		return s, by
	}
	if s, _ := status(kept); s != "queued" {
		t.Errorf("unchanged entry's run status = %q, want queued", s)
	}
	if s, by := status(stranded); s != "cancelled" || by != "system" {
		t.Errorf("changed entry's run status/cancelled_by = %q/%q, want cancelled/system", s, by)
	}
}
