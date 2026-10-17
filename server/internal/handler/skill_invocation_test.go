package handler

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// insertSkillInvocation records a skill load for a run, `ago` before now
// (a Postgres interval such as '2 hours').
func insertSkillInvocation(t *testing.T, taskID, skillID, agentID, ago string) {
	t.Helper()
	dbfx.InsertNoID(t, "skill_invocation", testutil.Cols{
		"task_id":      taskID,
		"skill_id":     skillID,
		"workspace_id": testWorkspaceID,
		"agent_id":     agentID,
		"invoked_at":   testutil.Raw("now() - interval '" + ago + "'"),
	}, "task_id = $1 AND skill_id = $2", taskID, skillID)
}

func skillInvocationCount(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		"SELECT count(*) FROM skill_invocation WHERE "+where, args...).Scan(&n); err != nil {
		t.Fatalf("count skill_invocation: %v", err)
	}
	return n
}

// skill_invocation has no foreign key, so deleting the skill must remove its
// usage rows in application code.
func TestSkillInvocation_RemovedWithSkill(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := dbfx.Agent(t, "invocation cleanup agent", handlerTestRuntimeID(t))
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "invocation-cleanup-skill")
	insertSkillInvocation(t, taskID, skillID, agentID, "1 hour")

	req := withURLParam(newRequest("DELETE", "/api/skills/"+skillID, nil), "id", skillID)
	testutil.Call(t, testHandler.DeleteSkill, req).Want(http.StatusNoContent)

	if n := skillInvocationCount(t, "skill_id = $1", skillID); n != 0 {
		t.Fatalf("skill delete left %d skill_invocation rows", n)
	}
}

// taskAgentID returns the agent that owns a seeded task.
func taskAgentID(t *testing.T, taskID string) string {
	t.Helper()
	var agentID string
	if err := testPool.QueryRow(context.Background(),
		"SELECT agent_id::text FROM agent_task_queue WHERE id = $1", taskID).Scan(&agentID); err != nil {
		t.Fatalf("load task agent: %v", err)
	}
	return agentID
}

func attachAgentSkill(t *testing.T, agentID, skillID string) {
	t.Helper()
	dbfx.InsertNoID(t, "agent_skill", testutil.Cols{"agent_id": agentID, "skill_id": skillID},
		"agent_id = $1 AND skill_id = $2", agentID, skillID)
}

func TestReportTaskMessages_RecordsSkillLoads(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	taskID := seedBatchTask(t, "skill-loads")
	agentID := taskAgentID(t, taskID)
	commitID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "Commit Usage")
	reviewID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "review-usage")
	attachAgentSkill(t, agentID, commitID)
	attachAgentSkill(t, agentID, reviewID)
	// Same slug in another workspace must never be recorded for this run. The
	// shared foreign-skill helper appends the test name to the skill name, which
	// would make the slug differ and this check vacuous, so insert it directly.
	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "Foreign Skill Usage Workspace",
		"slug":         "foreign-skill-usage-workspace",
		"description":  "",
		"issue_prefix": "FSU",
	})
	foreignID := insertProjectSkillFixtureSkill(t, foreignWorkspaceID, "review-usage")
	dbfx.Cleanup(t, `DELETE FROM skill_invocation WHERE task_id = $1`, taskID)

	testutil.Call(t, testHandler.ReportTaskMessages, batchMessagesRequest(t, taskID, []any{
		map[string]any{"seq": 1, "type": "tool_use", "tool": "Skill", "input": map[string]any{"skill": "commit-usage"}},
		map[string]any{"seq": 2, "type": "tool_use", "tool": "Read", "input": map[string]any{"file_path": "/w/.claude/skills/review-usage/SKILL.md"}},
		map[string]any{"seq": 3, "type": "tool_use", "tool": "Skill", "input": map[string]any{"skill": "not-attached"}},
	})).Want(http.StatusOK)

	if n := skillInvocationCount(t, "task_id = $1", taskID); n != 2 {
		t.Fatalf("recorded %d skill loads, want 2", n)
	}
	if n := skillInvocationCount(t, "skill_id = $1", foreignID); n != 0 {
		t.Fatalf("recorded a foreign workspace skill")
	}

	// A later batch loading the same skill again keeps one row per (run, skill).
	testutil.Call(t, testHandler.ReportTaskMessages, batchMessagesRequest(t, taskID, []any{
		map[string]any{"seq": 4, "type": "tool_use", "tool": "Skill", "input": map[string]any{"skill": "commit-usage"}},
	})).Want(http.StatusOK)
	if n := skillInvocationCount(t, "task_id = $1 AND skill_id = $2", taskID, commitID); n != 1 {
		t.Fatalf("repeat load left %d rows, want 1", n)
	}
}

func TestReportTaskMessages_RecordsProjectSkillLoad(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	taskID := seedBatchTask(t, "project-skill-load")
	projectID := dbfx.Project(t, "Skill load project")
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue SET project_id = $1 WHERE id = (SELECT issue_id FROM agent_task_queue WHERE id = $2)`,
		projectID, taskID); err != nil {
		t.Fatalf("attach issue to project: %v", err)
	}
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-load-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM skill_invocation WHERE task_id = $1`, taskID)

	testutil.Call(t, testHandler.ReportTaskMessages, batchMessagesRequest(t, taskID, []any{
		map[string]any{"seq": 1, "type": "tool_use", "tool": "exec_command",
			"input": map[string]any{"command": "cat /env/codex-home/skills/project-load-skill/SKILL.md"}},
	})).Want(http.StatusOK)

	if n := skillInvocationCount(t, "task_id = $1 AND skill_id = $2", taskID, skillID); n != 1 {
		t.Fatalf("project skill load recorded %d rows, want 1", n)
	}
}

func TestGetWorkspaceSkillUsage(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := dbfx.Agent(t, "usage agent", handlerTestRuntimeID(t))
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "usage-endpoint-skill")
	recent := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	older := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	stale := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	insertSkillInvocation(t, recent, skillID, agentID, "2 hours")
	insertSkillInvocation(t, older, skillID, agentID, "3 days")
	insertSkillInvocation(t, stale, skillID, agentID, "31 days")

	type row struct {
		SkillID    string  `json:"skill_id"`
		RunCount   int     `json:"run_count"`
		LastUsedAt *string `json:"last_used_at"`
	}
	var rows []row
	req := withChatTestWorkspaceCtx(t, newRequest(http.MethodGet, "/api/skills/usage", nil))
	testutil.Call(t, testHandler.GetWorkspaceSkillUsage, req).Want(http.StatusOK).JSON(&rows)

	var got *row
	for i := range rows {
		if rows[i].SkillID == skillID {
			got = &rows[i]
		}
	}
	if got == nil {
		t.Fatalf("skill %s missing from usage: %+v", skillID, rows)
	}
	// The 31-day-old run is outside the RUNS window.
	if got.RunCount != 2 {
		t.Fatalf("run_count = %d, want 2", got.RunCount)
	}
	if got.LastUsedAt == nil {
		t.Fatal("last_used_at = null")
	}
	at, err := time.Parse(time.RFC3339, *got.LastUsedAt)
	if err != nil {
		t.Fatalf("parse last_used_at %q: %v", *got.LastUsedAt, err)
	}
	if d := time.Since(at) - 2*time.Hour; d < -time.Minute || d > time.Minute {
		t.Fatalf("last_used_at = %s, want about 2h ago", *got.LastUsedAt)
	}
}

// LAST USED is not bounded by the RUNS window.
func TestGetWorkspaceSkillUsage_OnlyStaleRuns(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := dbfx.Agent(t, "stale usage agent", handlerTestRuntimeID(t))
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "stale-usage-skill")
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	insertSkillInvocation(t, taskID, skillID, agentID, "40 days")

	var rows []struct {
		SkillID    string  `json:"skill_id"`
		RunCount   int     `json:"run_count"`
		LastUsedAt *string `json:"last_used_at"`
	}
	req := withChatTestWorkspaceCtx(t, newRequest(http.MethodGet, "/api/skills/usage", nil))
	testutil.Call(t, testHandler.GetWorkspaceSkillUsage, req).Want(http.StatusOK).JSON(&rows)
	for _, r := range rows {
		if r.SkillID == skillID {
			if r.RunCount != 0 || r.LastUsedAt == nil {
				t.Fatalf("run_count/last_used_at = %d/%v, want 0/non-null", r.RunCount, r.LastUsedAt)
			}
			return
		}
	}
	t.Fatalf("skill %s missing from usage", skillID)
}

// Usage rows are scoped to the request workspace: a load recorded in another
// workspace must not appear in this workspace's response.
func TestGetWorkspaceSkillUsage_ExcludesForeignWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := dbfx.Agent(t, "foreign usage agent", handlerTestRuntimeID(t))
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed"})
	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "Foreign Usage Workspace",
		"slug":         "foreign-usage-workspace",
		"description":  "",
		"issue_prefix": "FUW",
	})
	foreignSkillID := insertProjectSkillFixtureSkill(t, foreignWorkspaceID, "foreign-usage-skill")
	dbfx.InsertNoID(t, "skill_invocation", testutil.Cols{
		"task_id":      taskID,
		"skill_id":     foreignSkillID,
		"workspace_id": foreignWorkspaceID,
		"agent_id":     agentID,
		"invoked_at":   testutil.Raw("now() - interval '1 hour'"),
	}, "task_id = $1 AND skill_id = $2", taskID, foreignSkillID)
	localSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "local-usage-skill")
	insertSkillInvocation(t, taskID, localSkillID, agentID, "2 hours")

	var rows []struct {
		SkillID string `json:"skill_id"`
	}
	req := withChatTestWorkspaceCtx(t, newRequest(http.MethodGet, "/api/skills/usage", nil))
	testutil.Call(t, testHandler.GetWorkspaceSkillUsage, req).Want(http.StatusOK).JSON(&rows)

	var sawLocal bool
	for _, r := range rows {
		switch r.SkillID {
		case foreignSkillID:
			t.Fatalf("foreign workspace skill %s leaked into usage response", foreignSkillID)
		case localSkillID:
			sawLocal = true
		}
	}
	if !sawLocal {
		t.Fatalf("local skill %s missing from usage: %+v", localSkillID, rows)
	}
}
