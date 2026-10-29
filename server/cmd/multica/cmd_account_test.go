package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const cliAccountTestToken = "placeholder-token-cli"

func newAccountTestCmd(flags func(*cobra.Command)) *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("output", "json", "")
	cmd.Flags().String("profile", "", "")
	flags(cmd)
	return cmd
}

func accountTestServer(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) {
	t.Helper()
	t.Chdir(t.TempDir())
	t.Setenv("MULTICA_AGENT_ID", "")
	t.Setenv("MULTICA_TASK_ID", "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/api/accounts" {
			_, _ = w.Write([]byte(`{"accounts":[{"id":"acc-1","name":"Claude A","provider":"claude","env_key_count":1}]}`))
			return
		}
		handle(w, r)
	}))
	t.Cleanup(srv.Close)
	setCLITestServerEnv(t, srv.URL)
}

func TestRunAccountCreateReadsEnvFileAndNeverPrintsValues(t *testing.T) {
	var got map[string]any
	accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/accounts" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"id":"acc-2","name":"Claude B","provider":"claude","env_key_count":1,"env_keys":["CLAUDE_CODE_OAUTH_TOKEN"]}`))
	})
	envFile := filepath.Join(t.TempDir(), "account.env.json")
	if err := os.WriteFile(envFile, []byte(`{"CLAUDE_CODE_OAUTH_TOKEN":"`+cliAccountTestToken+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := newAccountTestCmd(func(cmd *cobra.Command) {
		cmd.Flags().String("name", "", "")
		cmd.Flags().String("provider", "", "")
		cmd.Flags().Bool("env-stdin", false, "")
		cmd.Flags().String("env-file", "", "")
	})
	_ = cmd.Flags().Set("name", "Claude B")
	_ = cmd.Flags().Set("provider", "claude")
	_ = cmd.Flags().Set("env-file", envFile)

	out, err := captureStdout(t, func() error { return runAccountCreate(cmd, nil) })
	if err != nil {
		t.Fatalf("runAccountCreate: %v", err)
	}
	env, _ := got["env"].(map[string]any)
	if got["name"] != "Claude B" || got["provider"] != "claude" || env["CLAUDE_CODE_OAUTH_TOKEN"] != cliAccountTestToken {
		t.Fatalf("request body = %v", got)
	}
	if strings.Contains(out, cliAccountTestToken) {
		t.Fatalf("output leaked an env value: %s", out)
	}
}

func TestRunAccountUpdateEnvChannelsAreExclusive(t *testing.T) {
	cmd := newAccountTestCmd(func(cmd *cobra.Command) {
		cmd.Flags().Bool("env-stdin", false, "")
		cmd.Flags().String("env-file", "", "")
	})
	_ = cmd.Flags().Set("env-stdin", "true")
	_ = cmd.Flags().Set("env-file", "unused.json")
	if err := runAccountUpdate(cmd, []string{"Claude A"}); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("expected mutual-exclusion error, got %v", err)
	}
}

func TestRunAccountDeleteSurfacesAgentsInUse(t *testing.T) {
	accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/accounts/acc-1" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"cannot delete account \"Claude A\": it is used by agents: Builder","agents":[{"id":"a1","name":"Builder"}]}`))
	})
	err := runAccountDelete(newAccountTestCmd(func(*cobra.Command) {}), []string{"Claude A"})
	if err == nil || !strings.Contains(err.Error(), "Builder") {
		t.Fatalf("expected in-use error naming the agent, got %v", err)
	}
}

func TestRunAgentUpdateAccountFlag(t *testing.T) {
	cases := []struct {
		ref  string
		want any
	}{
		{"Claude A", "acc-1"},
		{"acc-1", "acc-1"},
		{"none", nil},
	}
	for _, tc := range cases {
		t.Run(tc.ref, func(t *testing.T) {
			var body map[string]any
			accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPut || r.URL.Path != "/api/agents/agent-1" {
					t.Fatalf("request = %s %s", r.Method, r.URL.Path)
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = w.Write([]byte(`{"id":"agent-1","name":"Builder"}`))
			})
			cmd := newAccountTestCmd(func(cmd *cobra.Command) { cmd.Flags().String("account", "", "") })
			_ = cmd.Flags().Set("account", tc.ref)
			if _, err := captureStdout(t, func() error { return runAgentUpdate(cmd, []string{"agent-1"}) }); err != nil {
				t.Fatalf("runAgentUpdate: %v", err)
			}
			got, present := body["account_id"]
			if !present || got != tc.want {
				t.Fatalf("account_id = %v (present=%v); want %v", got, present, tc.want)
			}
		})
	}

	t.Run("unknown", func(t *testing.T) {
		accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		})
		cmd := newAccountTestCmd(func(cmd *cobra.Command) { cmd.Flags().String("account", "", "") })
		_ = cmd.Flags().Set("account", "Missing")
		if err := runAgentUpdate(cmd, []string{"agent-1"}); err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("expected not-found error, got %v", err)
		}
	})
}

func TestRunAgentFallbackSetResolvesAccountRefs(t *testing.T) {
	var got map[string]any
	accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/agents/agent-1/fallbacks" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`[]`))
	})
	cmd := newAgentFallbackSetTestCmd()
	_ = cmd.Flags().Set("entry", "runtime=rt-claude,model=claude-opus-5-5,account=Claude A")
	if _, err := captureStdout(t, func() error { return runAgentFallbackSet(cmd, []string{"agent-1"}) }); err != nil {
		t.Fatalf("runAgentFallbackSet: %v", err)
	}
	want := `{"fallbacks":[{"account_id":"acc-1","model":"claude-opus-5-5","runtime_id":"rt-claude","thinking_level":""}]}`
	if b, _ := json.Marshal(got); string(b) != want {
		t.Fatalf("body = %s, want %s", b, want)
	}
}

func TestRunAccountUpdateSendsOverrideOnlyWhenSet(t *testing.T) {
	var got map[string]any
	accountTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"id":"acc-1","name":"Claude A"}`))
	})
	cmd := newAccountTestCmd(func(cmd *cobra.Command) {
		cmd.Flags().Bool("env-stdin", false, "")
		cmd.Flags().String("env-file", "", "")
		cmd.Flags().Bool("override-runtime-default", false, "")
	})
	_ = cmd.Flags().Set("override-runtime-default", "false")
	if _, err := captureStdout(t, func() error { return runAccountUpdate(cmd, []string{"Claude A"}) }); err != nil {
		t.Fatalf("runAccountUpdate: %v", err)
	}
	if v, ok := got["overrides_runtime_default"]; !ok || v != false || len(got) != 1 {
		t.Fatalf("body = %v; want only overrides_runtime_default=false", got)
	}
}
