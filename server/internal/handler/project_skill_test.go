package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func insertProjectSkillFixtureSkill(t *testing.T, workspaceID, name string) string {
	t.Helper()
	return dbfx.Insert(t, "skill", testutil.Cols{
		"workspace_id": workspaceID,
		"name":         name,
		"description":  "Project skill fixture",
		"content":      name + " content",
		"config":       testutil.Raw("'{}'::jsonb"),
		"created_by":   testUserID,
	})
}

func projectSkillCount(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM project_skill WHERE `+where, args...).Scan(&n)
	return n
}

func listProjectSkillsCall(t *testing.T, projectID string) []SkillSummaryResponse {
	t.Helper()
	req := withURLParam(newRequest("GET", "/api/projects/"+projectID+"/skills", nil), "id", projectID)
	var skills []SkillSummaryResponse
	testutil.Call(t, testHandler.ListProjectSkills, req).Want(http.StatusOK).JSON(&skills)
	return skills
}

func addProjectSkillCall(t *testing.T, projectID string, skillIDs ...string) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest("POST", "/api/projects/"+projectID+"/skills", map[string]any{
		"skill_ids": skillIDs,
	}), "id", projectID)
	return testutil.Call(t, testHandler.AddProjectSkills, req)
}

func removeProjectSkillCall(t *testing.T, projectID, skillID string) *testutil.Response {
	t.Helper()
	req := withURLParams(newRequest("DELETE", "/api/projects/"+projectID+"/skills/"+skillID, nil),
		"id", projectID, "skillId", skillID)
	return testutil.Call(t, testHandler.RemoveProjectSkill, req)
}

func TestProjectSkillLifecycle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Project skill lifecycle")
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-skill-lifecycle")
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	var added []SkillSummaryResponse
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK).JSON(&added)
	if len(added) != 1 || added[0].ID != skillID {
		t.Fatalf("add returned %+v, want exactly skill %s", added, skillID)
	}
	// Attaching an attached skill is a no-op, not a conflict.
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	addProjectSkillCall(t, projectID).Want(http.StatusBadRequest)

	skills := listProjectSkillsCall(t, projectID)
	if len(skills) != 1 || skills[0].ID != skillID {
		t.Fatalf("listed %+v, want exactly skill %s", skills, skillID)
	}

	removeProjectSkillCall(t, projectID, skillID).Want(http.StatusNoContent)
	removeProjectSkillCall(t, projectID, skillID).Want(http.StatusNotFound)
	if skills := listProjectSkillsCall(t, projectID); len(skills) != 0 {
		t.Fatalf("listed %+v after removal, want none", skills)
	}
}

func TestAddProjectSkill_RejectsForeignWorkspaceSkill(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "Foreign project skill",
		"slug":         "foreign-project-skill-ws",
		"description":  "",
		"issue_prefix": "FPS",
	})
	foreignSkillID := insertProjectSkillFixtureSkill(t, foreignWorkspaceID, "foreign-project-skill")
	projectID := dbfx.Project(t, "Project rejecting foreign skill")
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	// A batch with one foreign id attaches nothing.
	localSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "local-project-skill")
	addProjectSkillCall(t, projectID, localSkillID, foreignSkillID).Want(http.StatusNotFound)
	if n := projectSkillCount(t, "project_id = $1", projectID); n != 0 {
		t.Fatalf("foreign skill was attached: %d rows", n)
	}
}

// project_skill has no foreign keys, so deleting either side must remove the
// link in application code.
func TestProjectSkill_RemovedWithSkillAndProject(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Project skill cleanup")
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-skill-cleanup-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	req := withURLParam(newRequest("DELETE", "/api/skills/"+skillID, nil), "id", skillID)
	testutil.Call(t, testHandler.DeleteSkill, req).Want(http.StatusNoContent)
	if n := projectSkillCount(t, "skill_id = $1", skillID); n != 0 {
		t.Fatalf("skill delete left %d project_skill rows", n)
	}

	otherSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-skill-cleanup-project")
	addProjectSkillCall(t, projectID, otherSkillID).Want(http.StatusOK)
	req = withURLParam(newRequest("DELETE", "/api/projects/"+projectID, nil), "id", projectID)
	testutil.Call(t, testHandler.DeleteProject, req).Want(http.StatusNoContent)
	if n := projectSkillCount(t, "project_id = $1", projectID); n != 0 {
		t.Fatalf("project delete left %d project_skill rows", n)
	}
}

// A task in a project runs with the project's skills in addition to its
// agent's, and the resolve endpoint authorizes them the same way. A skill
// attached to another project must not resolve.
func TestClaimTask_DeliversProjectSkills(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	runtimeID := createClaimReclaimRuntime(t, ctx, "Project skills runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, "Project skills agent")

	projectID := dbfx.Project(t, "Project skills claim")
	otherProjectID := dbfx.Project(t, "Project skills other")
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = ANY($1::uuid[])`, []string{projectID, otherProjectID})
	dbfx.Exec(t, `UPDATE issue SET project_id = $1 WHERE id = $2`, projectID, issueID)

	agentSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-claim-agent-skill")
	projectSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-claim-project-skill")
	otherSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-claim-other-skill")
	disabledSkillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-claim-disabled-skill")
	dbfx.Cleanup(t, `DELETE FROM agent_skill WHERE agent_id = $1`, agentID)
	dbfx.Exec(t, `INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)`, agentID, agentSkillID)
	// The agent owner disabled this skill; the project attaching it must not
	// switch it back on.
	dbfx.Exec(t, `INSERT INTO agent_skill (agent_id, skill_id, enabled) VALUES ($1, $2, FALSE)`, agentID, disabledSkillID)
	// The agent's own skill is attached to the project too; it must arrive once.
	addProjectSkillCall(t, projectID, agentSkillID, projectSkillID, disabledSkillID).Want(http.StatusOK)
	addProjectSkillCall(t, otherProjectID, otherSkillID).Want(http.StatusOK)

	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID,
		"issue_id":   issueID,
	})

	req := newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+runtimeID+"/tasks/claim", nil, testWorkspaceID, "project-skills-daemon")
	req.Header.Set("X-Client-Capabilities", protocol.DaemonCapabilitySkillBundlesV1)
	req = withURLParam(req, "runtimeId", runtimeID)
	var claimResp struct {
		Task *AgentTaskResponse `json:"task"`
	}
	testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&claimResp)
	if claimResp.Task == nil || claimResp.Task.Agent == nil {
		t.Fatal("missing task agent in claim response")
	}

	counts := map[string]int{}
	for _, ref := range claimResp.Task.Agent.SkillRefs {
		counts[ref.ID]++
	}
	if counts[agentSkillID] != 1 || counts[projectSkillID] != 1 {
		t.Fatalf("skill refs = %+v, want agent and project skills exactly once", claimResp.Task.Agent.SkillRefs)
	}
	if counts[otherSkillID] != 0 {
		t.Fatalf("another project's skill reached the claim: %+v", claimResp.Task.Agent.SkillRefs)
	}
	if counts[disabledSkillID] != 0 {
		t.Fatalf("a skill the agent disabled reached the claim through the project: %+v", claimResp.Task.Agent.SkillRefs)
	}

	var resolved struct {
		Bundles []service.AgentSkillData `json:"bundles"`
	}
	resolveBundles(t, testHandler, runtimeID, taskID, workspaceRef(projectSkillID)).
		Want(http.StatusOK).JSON(&resolved)
	if len(resolved.Bundles) != 1 || resolved.Bundles[0].ID != projectSkillID {
		t.Fatalf("resolved %+v, want project skill %s", resolved.Bundles, projectSkillID)
	}
	resolveBundles(t, testHandler, runtimeID, taskID, workspaceRef(otherSkillID)).
		Want(http.StatusNotFound)
	resolveBundles(t, testHandler, runtimeID, taskID, workspaceRef(disabledSkillID)).
		Want(http.StatusNotFound)
}

// A project skill reaches agents the caller may not be able to edit, so only
// human workspace owners and admins can attach or detach one.
func TestProjectSkill_RequiresWorkspaceAdmin(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	memberID := dbfx.User(t, "Project skill member", "project-skill-member@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	projectID := dbfx.Project(t, "Project skill permissions")
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "project-skill-permissions")
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	req := withURLParam(newRequestAs(memberID, "POST", "/api/projects/"+projectID+"/skills", map[string]any{
		"skill_ids": []string{skillID},
	}), "id", projectID)
	testutil.Call(t, testHandler.AddProjectSkills, req).Want(http.StatusForbidden)

	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	req = withURLParams(newRequestAs(memberID, "DELETE", "/api/projects/"+projectID+"/skills/"+skillID, nil),
		"id", projectID, "skillId", skillID)
	testutil.Call(t, testHandler.RemoveProjectSkill, req).Want(http.StatusForbidden)

	// An agent running on an admin's behalf is refused too.
	req = withURLParam(newRequest("POST", "/api/projects/"+projectID+"/skills", map[string]any{
		"skill_ids": []string{skillID},
	}), "id", projectID)
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.AddProjectSkills, req).Want(http.StatusForbidden)
	req = withURLParams(newRequest("DELETE", "/api/projects/"+projectID+"/skills/"+skillID, nil),
		"id", projectID, "skillId", skillID)
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.RemoveProjectSkill, req).Want(http.StatusForbidden)

	// Members can still read the list.
	req = withURLParam(newRequestAs(memberID, "GET", "/api/projects/"+projectID+"/skills", nil), "id", projectID)
	testutil.Call(t, testHandler.ListProjectSkills, req).Want(http.StatusOK)
}

// The resolve path re-derives a task's project. It must pick the project the
// claim picked, or delivered project skills fail to resolve.
func TestResolveTaskProjectID_MatchesClaimPrecedence(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	runtimeID := createClaimReclaimRuntime(t, ctx, "Project precedence runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, "Project precedence agent")

	issueProjectID := dbfx.Project(t, "Precedence issue project")
	chatProjectID := dbfx.Project(t, "Precedence chat project")
	autopilotProjectID := dbfx.Project(t, "Precedence autopilot project")
	quickProjectID := dbfx.Project(t, "Precedence quick-create project")
	dbfx.Exec(t, `UPDATE issue SET project_id = $1 WHERE id = $2`, issueProjectID, issueID)
	chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"project_id": chatProjectID})
	autopilotID := dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"title":           "precedence autopilot",
		"assignee_id":     agentID,
		"execution_mode":  "run_only",
		"created_by_type": "member",
		"created_by_id":   testUserID,
		"project_id":      autopilotProjectID,
	})
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": autopilotID,
		"source":       "manual",
		"status":       "running",
	})
	quickContext, _ := json.Marshal(service.QuickCreateContext{
		Type:        service.QuickCreateContextType,
		WorkspaceID: testWorkspaceID,
		ProjectID:   quickProjectID,
	})

	tests := []struct {
		name string
		task db.AgentTaskQueue
		want string
	}{
		{"issue", db.AgentTaskQueue{IssueID: parseUUID(issueID)}, issueProjectID},
		{"chat", db.AgentTaskQueue{ChatSessionID: parseUUID(chatID)}, chatProjectID},
		{"autopilot", db.AgentTaskQueue{AutopilotRunID: parseUUID(runID)}, autopilotProjectID},
		// The claim's chat branch runs after its issue branch and overwrites it.
		{"chat over issue", db.AgentTaskQueue{IssueID: parseUUID(issueID), ChatSessionID: parseUUID(chatID)}, chatProjectID},
		{"quick-create", db.AgentTaskQueue{Context: quickContext}, quickProjectID},
		{"no link", db.AgentTaskQueue{}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := testHandler.TaskService.ResolveTaskProjectID(ctx, tc.task)
			if err != nil {
				t.Fatalf("ResolveTaskProjectID: %v", err)
			}
			gotID := ""
			if got.Valid {
				gotID = uuidToString(got)
			}
			if gotID != tc.want {
				t.Fatalf("project = %q, want %q", gotID, tc.want)
			}
		})
	}
}
