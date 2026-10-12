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
	cmd.Flags().Bool("except", false, "")
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
		"excluded":   false,
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

	cmd = newAudienceCmd(t, map[string]string{"except": "true", "labels": "label-interns"})
	if err := runProjectAudience(cmd, []string{projectID, "skill-1"}, "skills"); err != nil {
		t.Fatalf("runProjectAudience --except: %v", err)
	}
	if gotBody["restricted"] != false || gotBody["excluded"] != true ||
		!reflect.DeepEqual(gotBody["label_ids"], []any{"label-interns"}) {
		t.Fatalf("--except sent body=%v", gotBody)
	}
}

func TestAudienceSummaryNamesExclusions(t *testing.T) {
	item := func(a map[string]any) map[string]any { return map[string]any{"audience": a} }
	cases := []struct {
		item map[string]any
		want string
	}{
		{map[string]any{}, "all"},
		{item(map[string]any{"restricted": false, "agent_ids": []any{}, "label_ids": []any{}}), "all"},
		{item(map[string]any{"restricted": true, "agent_ids": []any{}, "label_ids": []any{}}), "nobody"},
		{item(map[string]any{"restricted": true, "agent_ids": []any{"a"}, "label_ids": []any{}}), "1 agents, 0 labels"},
		{item(map[string]any{"excluded": true, "agent_ids": []any{"a"}, "label_ids": []any{"l"}}), "all except 1 agents, 1 labels"},
		{item(map[string]any{"excluded": true, "agent_ids": []any{}, "label_ids": []any{}}), "all"},
	}
	for _, tc := range cases {
		if got := audienceSummary(tc.item); got != tc.want {
			t.Errorf("audienceSummary(%v) = %q, want %q", tc.item, got, tc.want)
		}
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
		{map[string]string{"except": "true"}, "--except needs at least one"},
		{map[string]string{"all": "true", "except": "true"}, "--all cannot be combined"},
	}
	for _, tc := range cases {
		err := runProjectAudience(newAudienceCmd(t, tc.flags), []string{"p", "s"}, "skills")
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("flags %v: err = %v, want %q", tc.flags, err, tc.want)
		}
	}
}
