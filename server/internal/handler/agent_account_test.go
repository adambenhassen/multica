package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

const accountTestToken = "placeholder-token-a"

func TestLayerAccountEnv_AccountWinsOverCustomEnv(t *testing.T) {
	custom := map[string]string{"ONLY_CUSTOM": "c", "SHARED": "from-custom"}
	account := map[string]string{"SHARED": "from-account", "ONLY_ACCOUNT": "a"}

	got := layerAccountEnv(custom, account)
	want := map[string]string{"ONLY_CUSTOM": "c", "SHARED": "from-account", "ONLY_ACCOUNT": "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("layerAccountEnv = %v; want %v", got, want)
	}
	if custom["SHARED"] != "from-custom" {
		t.Fatalf("layerAccountEnv mutated custom_env: %v", custom)
	}
	if got := layerAccountEnv(custom, nil); !reflect.DeepEqual(got, custom) {
		t.Fatalf("no account must leave custom_env unchanged, got %v", got)
	}
	if got := overriddenEnvKeys(custom, account); !reflect.DeepEqual(got, []string{"SHARED"}) {
		t.Fatalf("overriddenEnvKeys = %v; want [SHARED]", got)
	}
}

// createAccountForTest creates an account through the API as the workspace
// owner and returns its id.
func createAccountForTest(t *testing.T, name, provider string, env map[string]string) string {
	t.Helper()
	req := newRequest(http.MethodPost, "/api/accounts", map[string]any{"name": name, "provider": provider, "env": env})
	w := testutil.Call(t, testHandler.CreateAgentAccount, req).Want(http.StatusCreated)
	if strings.Contains(w.Body.String(), accountTestToken) {
		t.Fatalf("create response leaked an env value: %s", w.Body.String())
	}
	var resp AgentAccountResponse
	w.JSON(&resp)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `UPDATE agent SET account_id = NULL WHERE account_id = $1`, resp.ID)
		testPool.Exec(context.Background(), `DELETE FROM agent_account WHERE id = $1`, resp.ID)
	})
	return resp.ID
}

func TestAgentAccount_PermissionsAndSecretMasking(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()

	accountID := createAccountForTest(t, "Claude A", "claude", map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": accountTestToken})
	memberID := createPermissionTestMember(t, "account-member@multica.test")

	// Members can list (for the agent dropdown) but see neither values nor key names.
	w := httptest.NewRecorder()
	testHandler.ListAgentAccounts(w, newRequestAs(memberID, http.MethodGet, "/api/accounts", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("member list: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), accountTestToken) || strings.Contains(w.Body.String(), "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatalf("member list leaked env: %s", w.Body.String())
	}
	var list struct {
		Accounts []AgentAccountResponse `json:"accounts"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Accounts) != 1 || list.Accounts[0].EnvKeyCount != 1 {
		t.Fatalf("member list = %+v; want one account with env_key_count 1", list.Accounts)
	}

	// Owners/admins see key names, never values.
	w = httptest.NewRecorder()
	testHandler.ListAgentAccounts(w, newRequest(http.MethodGet, "/api/accounts", nil))
	if strings.Contains(w.Body.String(), accountTestToken) || !strings.Contains(w.Body.String(), "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatalf("owner list must carry key names but no values: %s", w.Body.String())
	}

	memberCases := []struct {
		name   string
		method string
		fn     func(http.ResponseWriter, *http.Request)
		body   any
	}{
		{"create", http.MethodPost, testHandler.CreateAgentAccount, map[string]any{"name": "Mine", "provider": "claude"}},
		{"update", http.MethodPut, testHandler.UpdateAgentAccount, map[string]any{"name": "Renamed"}},
		{"delete", http.MethodDelete, testHandler.DeleteAgentAccount, nil},
		{"reveal", http.MethodGet, testHandler.GetAgentAccountEnv, nil},
	}
	for _, tc := range memberCases {
		t.Run("member "+tc.name, func(t *testing.T) {
			req := withURLParam(newRequestAs(memberID, tc.method, "/api/accounts/"+accountID, tc.body), "id", accountID)
			w := httptest.NewRecorder()
			tc.fn(w, req)
			if w.Code != http.StatusForbidden {
				t.Fatalf("expected 403 for a plain member, got %d: %s", w.Code, w.Body.String())
			}
		})
	}

	t.Run("agent actor reveal", func(t *testing.T) {
		hostAgentID := createHandlerTestAgent(t, "account-host-agent", nil)
		req := withURLParam(newRequest(http.MethodGet, "/api/accounts/"+accountID+"/env", nil), "id", accountID)
		req.Header.Set("X-Agent-ID", hostAgentID)
		req.Header.Set("X-Task-ID", createHandlerTestTaskForAgent(t, hostAgentID))
		w := httptest.NewRecorder()
		testHandler.GetAgentAccountEnv(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for an agent actor, got %d: %s", w.Code, w.Body.String())
		}
	})

	// A masked value round-trip preserves the secret; a new key is added.
	req := withURLParam(newRequest(http.MethodPut, "/api/accounts/"+accountID, map[string]any{
		"env": map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": envSentinel, "EXTRA": "placeholder-extra"},
	}), "id", accountID)
	updated := testutil.Call(t, testHandler.UpdateAgentAccount, req).Want(http.StatusOK)
	if strings.Contains(updated.Body.String(), accountTestToken) {
		t.Fatalf("update response leaked an env value: %s", updated.Body.String())
	}

	// The owner reveal returns plaintext and leaves a key-only audit row.
	req = withURLParam(newRequest(http.MethodGet, "/api/accounts/"+accountID+"/env", nil), "id", accountID)
	var revealed AccountEnvResponse
	testutil.Call(t, testHandler.GetAgentAccountEnv, req).Want(http.StatusOK).JSON(&revealed)
	want := map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": accountTestToken, "EXTRA": "placeholder-extra"}
	if !reflect.DeepEqual(revealed.Env, want) {
		t.Fatalf("revealed env = %v; want %v", revealed.Env, want)
	}
	for _, action := range []string{accountEnvActivityRevealed, accountEnvActivityUpdated} {
		var details string
		if err := testPool.QueryRow(ctx, `
			SELECT details::text FROM activity_log
			WHERE workspace_id = $1 AND action = $2 AND details->>'account_id' = $3
			ORDER BY created_at DESC LIMIT 1
		`, testWorkspaceID, action, accountID).Scan(&details); err != nil {
			t.Fatalf("expected %s activity row: %v", action, err)
		}
		if strings.Contains(details, accountTestToken) || strings.Contains(details, "placeholder-extra") {
			t.Fatalf("%s details must not contain values: %s", action, details)
		}
	}
}

func TestAgentAccount_DeleteInUseListsAgents(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	accountID := createAccountForTest(t, "Claude In Use", "handler_test_runtime", map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": accountTestToken})
	agentID := createHandlerTestAgent(t, "account-user-agent", nil)

	req := withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"account_id": accountID}), "id", agentID)
	w := testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusOK)
	var agentResp AgentResponse
	w.JSON(&agentResp)
	if agentResp.AccountID == nil || *agentResp.AccountID != accountID {
		t.Fatalf("account_id = %v; want %s", agentResp.AccountID, accountID)
	}

	req = withURLParam(newRequest(http.MethodDelete, "/api/accounts/"+accountID, nil), "id", accountID)
	w = testutil.Call(t, testHandler.DeleteAgentAccount, req).Want(http.StatusConflict)
	var conflict struct {
		Error  string            `json:"error"`
		Agents []accountAgentRef `json:"agents"`
	}
	w.JSON(&conflict)
	if !strings.Contains(conflict.Error, "account-user-agent") || len(conflict.Agents) != 1 || conflict.Agents[0].ID != agentID {
		t.Fatalf("conflict must name the agent using the account, got %+v", conflict)
	}

	// Clearing the selection frees the account.
	req = withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"account_id": nil}), "id", agentID)
	testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusOK)
	req = withURLParam(newRequest(http.MethodDelete, "/api/accounts/"+accountID, nil), "id", accountID)
	testutil.Call(t, testHandler.DeleteAgentAccount, req).Want(http.StatusNoContent)
}

func TestUpdateAgent_AccountMustMatchProviderAndClearsOnProviderChange(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	matching := createAccountForTest(t, "Matching", "handler_test_runtime", map[string]string{"TOKEN": "placeholder"})
	foreign := createAccountForTest(t, "Codex B", "codex", map[string]string{"TOKEN": "placeholder"})
	agentID := createHandlerTestAgent(t, "account-provider-agent", nil)

	req := withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"account_id": foreign}), "id", agentID)
	testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusBadRequest)

	req = withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"account_id": matching}), "id", agentID)
	testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusOK)

	// Same provider: the account survives a runtime move.
	sameProviderRuntime := dbfx.Runtime(t, "account same-provider runtime")
	req = withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"runtime_id": sameProviderRuntime}), "id", agentID)
	w := testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusOK)
	var resp AgentResponse
	w.JSON(&resp)
	if resp.AccountID == nil || *resp.AccountID != matching {
		t.Fatalf("same-provider move must keep the account, got %v", resp.AccountID)
	}

	otherRuntime := dbfx.Runtime(t, "account other-provider runtime", testutil.Cols{"provider": "codex"})
	req = withURLParam(newRequest(http.MethodPut, "/api/agents/"+agentID, map[string]any{"runtime_id": otherRuntime}), "id", agentID)
	w = testutil.Call(t, testHandler.UpdateAgent, req).Want(http.StatusOK)
	resp = AgentResponse{}
	w.JSON(&resp)
	if resp.AccountID != nil {
		t.Fatalf("moving to another provider must clear account_id, got %s", *resp.AccountID)
	}
}

func TestAgentEnv_ReportsKeysOverriddenByAccount(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	accountID := createAccountForTest(t, "Claude Override", "handler_test_runtime", map[string]string{"API_KEY": accountTestToken})
	agentID := createHandlerTestAgent(t, "account-override-agent", nil)
	dbfx.Exec(t, `UPDATE agent SET custom_env = '{"API_KEY":"custom","OTHER":"x"}', account_id = $1 WHERE id = $2`, accountID, agentID)

	req := withURLParam(newRequest(http.MethodGet, "/api/agents/"+agentID+"/env", nil), "id", agentID)
	w := testutil.Call(t, testHandler.GetAgentEnv, req).Want(http.StatusOK)
	if strings.Contains(w.Body.String(), accountTestToken) {
		t.Fatalf("agent env reveal must not carry account values: %s", w.Body.String())
	}
	var resp AgentEnvResponse
	w.JSON(&resp)
	if resp.AccountOverride == nil || resp.AccountOverride.AccountName != "Claude Override" || !reflect.DeepEqual(resp.AccountOverride.Keys, []string{"API_KEY"}) {
		t.Fatalf("account_override = %+v; want Claude Override over [API_KEY]", resp.AccountOverride)
	}
}

// claimAgentEnvForTest claims the next task on runtimeID and returns the
// custom_env the daemon receives.
func claimAgentEnvForTest(t *testing.T, runtimeID string) (string, map[string]string) {
	t.Helper()
	req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil), "runtimeId", runtimeID)
	w := testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK)
	var resp struct {
		Task *struct {
			ID    string `json:"id"`
			Agent *struct {
				CustomEnv map[string]string `json:"custom_env"`
			} `json:"agent"`
		} `json:"task"`
	}
	w.JSON(&resp)
	if resp.Task == nil || resp.Task.Agent == nil {
		t.Fatalf("expected a claimed task with agent data: %s", w.Body.String())
	}
	return resp.Task.ID, resp.Task.Agent.CustomEnv
}

// The claim payload carries custom_env with the account layered on top; the
// daemon applies it over its process env through isBlockedEnvKey. A switch
// changes only tasks claimed afterwards.
func TestClaim_LayersAccountEnvOverCustomEnvPerClaim(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runtimeID := createClaimReclaimRuntime(t, ctx, "Account claim runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, "Account claim agent")
	accountA := createAccountForTest(t, "Claim A", "handler_test_runtime", map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "placeholder-a", "SHARED": "from-account"})
	accountB := createAccountForTest(t, "Claim B", "handler_test_runtime", map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "placeholder-b"})
	dbfx.Exec(t, `UPDATE agent SET custom_env = '{"SHARED":"from-custom","ONLY_CUSTOM":"c"}', account_id = $1 WHERE id = $2`, accountA, agentID)

	first := createDispatchedClaimFixtureTask(t, ctx, agentID, runtimeID, issueID, "120 seconds", false)
	claimedID, env := claimAgentEnvForTest(t, runtimeID)
	if claimedID != first {
		t.Fatalf("claimed %s; want %s", claimedID, first)
	}
	want := map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "placeholder-a", "SHARED": "from-account", "ONLY_CUSTOM": "c"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("claimed env = %v; want %v", env, want)
	}

	// The first run is in flight with account A's env when the agent switches.
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'running', started_at = now() WHERE id = $1`, first)
	dbfx.Exec(t, `UPDATE agent SET account_id = $1 WHERE id = $2`, accountB, agentID)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, first)
	second := createDispatchedClaimFixtureTask(t, ctx, agentID, runtimeID, issueID, "120 seconds", false)
	claimedID, env = claimAgentEnvForTest(t, runtimeID)
	if claimedID != second {
		t.Fatalf("claimed %s; want %s", claimedID, second)
	}
	want = map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "placeholder-b", "SHARED": "from-custom", "ONLY_CUSTOM": "c"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("claimed env after switch = %v; want %v", env, want)
	}
}
