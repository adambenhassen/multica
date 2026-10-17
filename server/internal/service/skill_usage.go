package service

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Skill directory naming, copied from the daemon (server/internal/daemon/execenv:
// sanitizeSkillName, resolveSkillSlugs, skillSlugCandidate). Deployed daemons
// run the upstream build, so this tracks upstream's naming; the parity test in
// skill_usage_test.go pins it. Not reproduced: the extra suffix the daemon adds
// when a user-installed directory already holds the slug.
var skillSlugNonAlphaNum = regexp.MustCompile(`[^a-z0-9]+`)

func sanitizeSkillSlug(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = skillSlugNonAlphaNum.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "skill"
	}
	return s
}

func skillSlugCandidate(base string, attempt int) string {
	switch {
	case attempt <= 0:
		return base
	case attempt == 1:
		return base + "-multica"
	default:
		return fmt.Sprintf("%s-multica-%d", base, attempt)
	}
}

// skillSlugs names each skill's directory the way the daemon does for a claim
// whose skills arrive in this order.
func skillSlugs(names []string) []string {
	slugs := make([]string, len(names))
	taken := make(map[string]struct{}, len(names))
	for i, name := range names {
		base := sanitizeSkillSlug(name)
		slug := base
		for attempt := 1; ; attempt++ {
			if _, clash := taken[slug]; !clash {
				break
			}
			slug = skillSlugCandidate(base, attempt)
		}
		taken[slug] = struct{}{}
		slugs[i] = slug
	}
	return slugs
}

// SkillToolCall is the part of a transcript tool_use message skill detection reads.
type SkillToolCall struct {
	Tool  string
	Input map[string]any
}

var (
	skillSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	skillFilePattern = regexp.MustCompile(`(?:^|[/\\\s"'=])skills[/\\]([a-z0-9]+(?:-[a-z0-9]+)*)[/\\]SKILL\.md`)
)

// DetectSkillSlugs returns the skill directory slugs a batch of tool calls
// loaded: a native skill tool (Claude Code `Skill{skill}`, older
// `Skill{command}`, OpenCode `skill{name}`), or any input string naming a
// `skills/<slug>/SKILL.md` file (reads and shell commands of every other
// agent). Plugin-namespaced names are not workspace skills and are skipped.
func DetectSkillSlugs(calls []SkillToolCall) []string {
	seen := make(map[string]struct{})
	for _, call := range calls {
		if strings.EqualFold(call.Tool, "skill") {
			for _, key := range []string{"skill", "command", "name"} {
				if v, _ := call.Input[key].(string); v != "" {
					if skillSlugPattern.MatchString(v) {
						seen[v] = struct{}{}
					}
					break
				}
			}
		}
		walkInputStrings(call.Input, func(s string) {
			for _, m := range skillFilePattern.FindAllStringSubmatch(s, -1) {
				seen[m[1]] = struct{}{}
			}
		})
	}
	if len(seen) == 0 {
		return nil
	}
	slugs := make([]string, 0, len(seen))
	for slug := range seen {
		slugs = append(slugs, slug)
	}
	slices.Sort(slugs)
	return slugs
}

func walkInputStrings(v any, fn func(string)) {
	switch x := v.(type) {
	case string:
		fn(x)
	case map[string]any:
		for _, e := range x {
			walkInputStrings(e, fn)
		}
	case []any:
		for _, e := range x {
			walkInputStrings(e, fn)
		}
	}
}

// RecordSkillInvocations records that a run loaded the skills its transcript
// named by directory slug. Slugs resolve against the run's skill set in the
// order the claim delivered it — agent and project skills merged by name
// (mergeTaskSkills) — because that order decides the daemon's collision
// suffixes. Built-ins follow workspace skills in the claim, so they never
// shift these slugs. Slugs that match no workspace skill (built-ins,
// user-installed skills) are dropped.
func (s *TaskService) RecordSkillInvocations(ctx context.Context, task db.AgentTaskQueue, workspaceID pgtype.UUID, slugs []string) error {
	skills, err := s.Queries.ListAgentSkills(ctx, task.AgentID)
	if err != nil {
		return fmt.Errorf("list agent skills: %w", err)
	}
	projectID, err := s.ResolveTaskProjectID(ctx, task)
	if err != nil {
		return fmt.Errorf("resolve task project: %w", err)
	}
	if projectID.Valid {
		projectSkills, err := s.Queries.ListProjectSkillsForAgent(ctx, db.ListProjectSkillsForAgentParams{
			ProjectID:   projectID,
			WorkspaceID: workspaceID,
			AgentID:     task.AgentID,
		})
		if err != nil {
			return fmt.Errorf("list project skills: %w", err)
		}
		skills = mergeTaskSkills(skills, projectSkills)
	}

	names := make([]string, len(skills))
	for i, sk := range skills {
		names[i] = sk.Name
	}
	idBySlug := make(map[string]pgtype.UUID, len(skills))
	for i, slug := range skillSlugs(names) {
		idBySlug[slug] = skills[i].ID
	}
	var ids []pgtype.UUID
	for _, slug := range slugs {
		if id, ok := idBySlug[slug]; ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	if err := s.Queries.CreateSkillInvocations(ctx, db.CreateSkillInvocationsParams{
		TaskID:      task.ID,
		SkillIds:    ids,
		WorkspaceID: workspaceID,
		AgentID:     task.AgentID,
	}); err != nil {
		return fmt.Errorf("create skill invocations: %w", err)
	}
	return nil
}
