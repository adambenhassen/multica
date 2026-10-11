package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func newAudienceCmd(t *testing.T, flags map[string]string) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{Use: "audience"}
	cmd.Flags().Bool("all", false, "")
	cmd.Flags().Bool("nobody", false, "")
	cmd.Flags().StringSlice("agents", nil, "")
	cmd.Flags().StringSlice("labels", nil, "")
	cmd.Flags().String("output", "json", "")
	cmd.Flags().String("profile", "", "")
	for k, v := range flags {
		if err := cmd.Flags().Set(k, v); err != nil {
			t.Fatal(err)
		}
	}
	return cmd
}

func TestProjectAudienceSendsRestrictedTargets(t *testing.T) {
	const projectID = "11111111-1111-1111-1111-111111111111"
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode([]map[string]any{})
	}))
	defer srv.Close()
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	cmd := newAudienceCmd(t, map[string]string{"agents": "agent-a, agent-b", "labels": "label-ops"})
	if err := runProjectAudience(cmd, []string{projectID, "skill-1"}, "skills"); err != nil {
		t.Fatalf("runProjectAudience: %v", err)
	}
	if gotPath != "/api/projects/"+projectID+"/skills/skill-1/audience" {
		t.Fatalf("path = %q", gotPath)
	}
	want := map[string]any{
		"restricted": true,
		"agent_ids":  []any{"agent-a", "agent-b"},
		"label_ids":  []any{"label-ops"},
	}
	if !reflect.DeepEqual(gotBody, want) {
		t.Fatalf("body = %v, want %v", gotBody, want)
	}

	cmd = newAudienceCmd(t, map[string]string{"all": "true"})
	if err := runProjectAudience(cmd, []string{projectID, "server-1"}, "mcp-servers"); err != nil {
		t.Fatalf("runProjectAudience --all: %v", err)
	}
	if gotPath != "/api/projects/"+projectID+"/mcp-servers/server-1/audience" || gotBody["restricted"] != false {
		t.Fatalf("--all sent path=%q body=%v", gotPath, gotBody)
	}
}

func TestProjectAudienceRejectsConflictingFlags(t *testing.T) {
	t.Setenv("MULTICA_SERVER_URL", "http://127.0.0.1:0")
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")
	cases := []struct {
		flags map[string]string
		want  string
	}{
		{map[string]string{}, "pass --all, --nobody"},
		{map[string]string{"all": "true", "agents": "a"}, "--all cannot be combined"},
		{map[string]string{"nobody": "true", "labels": "l"}, "--nobody cannot be combined"},
	}
	for _, tc := range cases {
		err := runProjectAudience(newAudienceCmd(t, tc.flags), []string{"p", "s"}, "skills")
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("flags %v: err = %v, want %q", tc.flags, err, tc.want)
		}
	}
}
