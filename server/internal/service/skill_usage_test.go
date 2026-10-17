package service

import (
	"slices"
	"testing"
)

// Pins the daemon's directory naming (upstream
// server/internal/daemon/execenv: sanitizeSkillName, resolveSkillSlugs,
// skillSlugCandidate). A drift here means transcript paths stop resolving.
func TestSkillSlugs_MatchesDaemonNaming(t *testing.T) {
	cases := []struct {
		names []string
		want  []string
	}{
		{[]string{"PR review"}, []string{"pr-review"}},
		{[]string{"  deploy-target-lampahub.com "}, []string{"deploy-target-lampahub-com"}},
		{[]string{""}, []string{"skill"}},
		{[]string{"!!!"}, []string{"skill"}},
		{[]string{"A b", "a-b", "A_B"}, []string{"a-b", "a-b-multica", "a-b-multica-2"}},
	}
	for _, c := range cases {
		if got := skillSlugs(c.names); !slices.Equal(got, c.want) {
			t.Errorf("skillSlugs(%q) = %q, want %q", c.names, got, c.want)
		}
	}
}

func TestDetectSkillSlugs(t *testing.T) {
	cases := []struct {
		name  string
		calls []SkillToolCall
		want  []string
	}{
		{"claude native", []SkillToolCall{{Tool: "Skill", Input: map[string]any{"skill": "commit"}}}, []string{"commit"}},
		{"claude native legacy key", []SkillToolCall{{Tool: "Skill", Input: map[string]any{"command": "commit"}}}, []string{"commit"}},
		{"opencode native", []SkillToolCall{{Tool: "skill", Input: map[string]any{"name": "dev-test-driven"}}}, []string{"dev-test-driven"}},
		{"plugin-namespaced native ignored", []SkillToolCall{{Tool: "Skill", Input: map[string]any{"skill": "superpowers:brainstorming"}}}, nil},
		{"claude read", []SkillToolCall{{Tool: "Read", Input: map[string]any{"file_path": "/w/.claude/skills/commit/SKILL.md"}}}, []string{"commit"}},
		{"codex cat", []SkillToolCall{{Tool: "exec_command", Input: map[string]any{"command": "cat /env/codex-home/skills/review-code/SKILL.md"}}}, []string{"review-code"}},
		{"codex sed", []SkillToolCall{{Tool: "exec_command", Input: map[string]any{"command": "sed -n '1,220p' /env/codex-home/skills/review-code/SKILL.md"}}}, []string{"review-code"}},
		{"pi read", []SkillToolCall{{Tool: "read", Input: map[string]any{"path": "/w/.pi/skills/qa-linux-desktop/SKILL.md"}}}, []string{"qa-linux-desktop"}},
		{"opencode read", []SkillToolCall{{Tool: "read", Input: map[string]any{"filePath": "/w/.opencode/skills/commit/SKILL.md"}}}, []string{"commit"}},
		{"relative path", []SkillToolCall{{Tool: "Bash", Input: map[string]any{"command": "cat skills/commit/SKILL.md"}}}, []string{"commit"}},
		{"windows separators", []SkillToolCall{{Tool: "read", Input: map[string]any{"path": `C:\w\.cursor\skills\commit\SKILL.md`}}}, []string{"commit"}},
		{"nested input", []SkillToolCall{{Tool: "mcp", Input: map[string]any{"arguments": map[string]any{"paths": []any{"/w/.kiro/skills/commit/SKILL.md"}}}}}, []string{"commit"}},
		{"supporting file ignored", []SkillToolCall{{Tool: "Read", Input: map[string]any{"file_path": "/w/.claude/skills/commit/README.md"}}}, nil},
		{"lookalike dir ignored", []SkillToolCall{{Tool: "Read", Input: map[string]any{"file_path": "/w/myskills/commit/SKILL.md"}}}, nil},
		{"nil input", []SkillToolCall{{Tool: "Skill"}}, nil},
		{"dedup and sort", []SkillToolCall{
			{Tool: "Skill", Input: map[string]any{"skill": "zeta"}},
			{Tool: "Read", Input: map[string]any{"file_path": "/w/.claude/skills/alpha/SKILL.md"}},
			{Tool: "Read", Input: map[string]any{"file_path": "/w/.claude/skills/zeta/SKILL.md"}},
		}, []string{"alpha", "zeta"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := DetectSkillSlugs(c.calls); !slices.Equal(got, c.want) {
				t.Fatalf("DetectSkillSlugs = %q, want %q", got, c.want)
			}
		})
	}
}
