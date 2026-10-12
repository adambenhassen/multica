package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// audienceAgent is one agent with its own runtime and a queued task on an
// issue in the given project, so each agent's claim is independent.
type audienceAgent struct {
	agentID, runtimeID, issueID string
}

func newAudienceAgent(t *testing.T, ctx context.Context, name, projectID string) audienceAgent {
	t.Helper()
	runtimeID := createClaimReclaimRuntime(t, ctx, name+" runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, name+" agent")
	dbfx.Exec(t, `UPDATE issue SET project_id = $1 WHERE id = $2`, projectID, issueID)
	dbfx.Cleanup(t, `DELETE FROM agent_to_label WHERE agent_id = $1`, agentID)
	return audienceAgent{agentID: agentID, runtimeID: runtimeID, issueID: issueID}
}

// queueTask settles any earlier task for this agent first: an issue allows
// one pending task per agent.
func (a audienceAgent) queueTask(t *testing.T) string {
	t.Helper()
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now()
		WHERE agent_id = $1 AND status IN ('queued', 'dispatched', 'running')`, a.agentID)
	return dbfx.Task(t, a.agentID, testutil.Cols{"runtime_id": a.runtimeID, "issue_id": a.issueID})
}

// claimSkillIDs claims the agent's queued task and returns the skill ids the
// slim claim referenced.
func (a audienceAgent) claimSkillIDs(t *testing.T) map[string]bool {
	t.Helper()
	req := newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+a.runtimeID+"/tasks/claim", nil, testWorkspaceID, "audience-daemon")
	req.Header.Set("X-Client-Capabilities", protocol.DaemonCapabilitySkillBundlesV1)
	req = withURLParam(req, "runtimeId", a.runtimeID)
	var resp struct {
		Task *AgentTaskResponse `json:"task"`
	}
	testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&resp)
	if resp.Task == nil || resp.Task.Agent == nil {
		t.Fatal("claim returned no task")
	}
	ids := map[string]bool{}
	for _, ref := range resp.Task.Agent.SkillRefs {
		ids[ref.ID] = true
	}
	return ids
}

func setAudienceCall(t *testing.T, kind, projectID, itemID string, body map[string]any) *testutil.Response {
	t.Helper()
	path := "/api/projects/" + projectID + "/" + kind + "/" + itemID + "/audience"
	if kind == "skills" {
		req := withURLParams(newRequest("PUT", path, body), "id", projectID, "skillId", itemID)
		return testutil.Call(t, testHandler.SetProjectSkillAudience, req)
	}
	req := withURLParams(newRequest("PUT", path, body), "id", projectID, "serverId", itemID)
	return testutil.Call(t, testHandler.SetProjectMcpServerAudience, req)
}

func insertAgentLabel(t *testing.T, name string) string {
	t.Helper()
	return dbfx.Insert(t, "issue_label", testutil.Cols{
		"workspace_id":  testWorkspaceID,
		"resource_type": "agent",
		"name":          name,
		"color":         "#3b82f6",
	})
}

// A restricted project skill reaches only its audience: listed agents and
// agents carrying a listed label. Everyone else in the project is left out,
// including at skill-bundle resolve time.
func TestProjectSkillAudience_LimitsDelivery(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience skills")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	listed := newAudienceAgent(t, ctx, "audience-listed", projectID)
	labelled := newAudienceAgent(t, ctx, "audience-labelled", projectID)
	outsider := newAudienceAgent(t, ctx, "audience-outsider", projectID)
	labelID := insertAgentLabel(t, "audience-ops")
	dbfx.Exec(t, `INSERT INTO agent_to_label (agent_id, label_id) VALUES ($1, $2)`, labelled.agentID, labelID)

	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "audience-restricted-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)

	var listedResp []ProjectSkillResponse
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "agent_ids": []string{listed.agentID}, "label_ids": []string{labelID},
	}).Want(http.StatusOK).JSON(&listedResp)
	if len(listedResp) != 1 || !listedResp[0].Audience.Restricted ||
		len(listedResp[0].Audience.AgentIDs) != 1 || len(listedResp[0].Audience.LabelIDs) != 1 {
		t.Fatalf("audience response = %+v", listedResp)
	}

	if !(func() bool { listed.queueTask(t); return listed.claimSkillIDs(t)[skillID] })() {
		t.Fatal("listed agent did not receive the restricted skill")
	}
	if !(func() bool { labelled.queueTask(t); return labelled.claimSkillIDs(t)[skillID] })() {
		t.Fatal("agent carrying the listed label did not receive the restricted skill")
	}
	outsiderTask := outsider.queueTask(t)
	if outsider.claimSkillIDs(t)[skillID] {
		t.Fatal("agent outside the audience received the restricted skill")
	}
	resolveBundles(t, testHandler, outsider.runtimeID, outsiderTask, workspaceRef(skillID)).Want(http.StatusNotFound)

	// Lifting the restriction reaches everyone again.
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{"restricted": false}).Want(http.StatusOK)
	if n := projectAttachmentAudienceCount(t, projectID); n != 0 {
		t.Fatalf("unrestricting left %d audience rows", n)
	}
	outsider.queueTask(t)
	if !outsider.claimSkillIDs(t)[skillID] {
		t.Fatal("unrestricted skill did not reach every agent")
	}
}

// Deleting the last label target must never widen a restricted link: it then
// reaches nobody rather than everyone.
func TestProjectAttachmentAudience_FailsClosedWhenTargetsDisappear(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience fail closed")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	labelled := newAudienceAgent(t, ctx, "audience-failclosed", projectID)
	labelID := insertAgentLabel(t, "audience-failclosed-label")
	dbfx.Exec(t, `INSERT INTO agent_to_label (agent_id, label_id) VALUES ($1, $2)`, labelled.agentID, labelID)
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "audience-failclosed-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "label_ids": []string{labelID},
	}).Want(http.StatusOK)

	req := withURLParam(newRequest("DELETE", "/api/labels/"+labelID, nil), "id", labelID)
	testutil.Call(t, testHandler.DeleteLabel, req).Want(http.StatusNoContent)
	if n := projectAttachmentAudienceCount(t, projectID); n != 0 {
		t.Fatalf("label delete left %d audience rows", n)
	}

	labelled.queueTask(t)
	if labelled.claimSkillIDs(t)[skillID] {
		t.Fatal("restricted skill widened after its only target was deleted")
	}

	// Detaching the link takes its audience with it.
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "agent_ids": []string{labelled.agentID},
	}).Want(http.StatusOK)
	removeProjectSkillCall(t, projectID, skillID).Want(http.StatusNoContent)
	if n := projectAttachmentAudienceCount(t, projectID); n != 0 {
		t.Fatalf("detach left %d audience rows", n)
	}
}

func TestProjectMcpServerAudience_LimitsDelivery(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience MCP")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)

	listed := newAudienceAgent(t, ctx, "audience-mcp-listed", projectID)
	outsider := newAudienceAgent(t, ctx, "audience-mcp-outsider", projectID)
	serverID := createWorkspaceMcpServerForTest(t, "audience-mcp", `{"url":"https://audience.example"}`)
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE item_id = $1`, serverID)
	addProjectMcpServerCall(t, projectID, serverID).Want(http.StatusOK)
	var resp []ProjectMcpServerResponse
	setAudienceCall(t, "mcp-servers", projectID, serverID, map[string]any{
		"restricted": true, "agent_ids": []string{listed.agentID},
	}).Want(http.StatusOK).JSON(&resp)
	if len(resp) != 1 || !resp[0].Audience.Restricted {
		t.Fatalf("audience response = %+v", resp)
	}

	listed.queueTask(t)
	if decodeServers(t, claimAgentMcpConfigForTest(t, listed.runtimeID))["audience-mcp"] == nil {
		t.Fatal("listed agent did not receive the restricted MCP server")
	}
	outsider.queueTask(t)
	if decodeServers(t, claimAgentMcpConfigForTest(t, outsider.runtimeID))["audience-mcp"] != nil {
		t.Fatal("agent outside the audience received the restricted MCP server")
	}

	// Deleting the library entry sweeps the audience too.
	req := withURLParams(newRequest(http.MethodDelete, "/api/workspaces/"+testWorkspaceID+"/mcp-servers/"+serverID, nil),
		"id", testWorkspaceID, "serverId", serverID)
	testutil.Call(t, testHandler.DeleteWorkspaceMcpServer, req).Want(http.StatusNoContent)
	if n := projectAttachmentAudienceCount(t, projectID); n != 0 {
		t.Fatalf("library delete left %d audience rows", n)
	}
}

func TestProjectAttachmentAudience_Validation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	projectID := dbfx.Project(t, "Audience validation")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "audience-validation-skill")
	unattached := insertProjectSkillFixtureSkill(t, testWorkspaceID, "audience-validation-unattached")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	issueLabelID := dbfx.Insert(t, "issue_label", testutil.Cols{
		"workspace_id": testWorkspaceID, "resource_type": "issue", "name": "audience-issue-label", "color": "#000000",
	})
	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name": "Foreign audience", "slug": "foreign-audience-ws", "description": "", "issue_prefix": "FAU",
	})
	foreignRuntime := dbfx.Runtime(t, "foreign audience runtime", testutil.Cols{"workspace_id": foreignWorkspaceID})
	foreignAgent := dbfx.Agent(t, "foreign audience agent", foreignRuntime, testutil.Cols{"workspace_id": foreignWorkspaceID})

	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": false, "agent_ids": []string{foreignAgent},
	}).Want(http.StatusBadRequest)
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "agent_ids": []string{foreignAgent},
	}).Want(http.StatusNotFound)
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "label_ids": []string{issueLabelID},
	}).Want(http.StatusNotFound)
	setAudienceCall(t, "skills", projectID, unattached, map[string]any{"restricted": true}).Want(http.StatusNotFound)

	memberID := dbfx.User(t, "Audience member", "audience-member@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	path := "/api/projects/" + projectID + "/skills/" + skillID + "/audience"
	req := withURLParams(newRequestAs(memberID, "PUT", path, map[string]any{"restricted": true}), "id", projectID, "skillId", skillID)
	testutil.Call(t, testHandler.SetProjectSkillAudience, req).Want(http.StatusForbidden)
	req = withURLParams(newRequest("PUT", path, map[string]any{"restricted": true}), "id", projectID, "skillId", skillID)
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.SetProjectSkillAudience, req).Want(http.StatusForbidden)

	// Restricted with no targets is allowed and means nobody.
	var resp []ProjectSkillResponse
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{"restricted": true}).Want(http.StatusOK).JSON(&resp)
	if len(resp) != 1 || !resp[0].Audience.Restricted || len(resp[0].Audience.AgentIDs) != 0 {
		t.Fatalf("restricted-to-nobody response = %+v", resp)
	}
}

func projectAttachmentAudienceCount(t *testing.T, projectID string) int {
	t.Helper()
	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM project_attachment_audience WHERE project_id = $1`, projectID).Scan(&n)
	return n
}

// Agent owners can label their own agents. A label that grants a restricted
// project item must not be self-assignable, or any member could opt in.
func TestAttachLabelToAgent_AudienceLabelRequiresAdmin(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience label gate")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	memberID := dbfx.User(t, "Label gate member", "label-gate-member@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	runtimeID := createClaimReclaimRuntime(t, ctx, "label gate runtime")
	agentID := dbfx.Agent(t, "label gate agent", runtimeID, testutil.Cols{"owner_id": memberID})
	dbfx.Cleanup(t, `DELETE FROM agent_to_label WHERE agent_id = $1`, agentID)

	plainLabel := insertAgentLabel(t, "label-gate-plain")
	gatedLabel := insertAgentLabel(t, "label-gate-ops")
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "label-gate-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "label_ids": []string{gatedLabel},
	}).Want(http.StatusOK)

	attach := func(userID, labelID string) *testutil.Response {
		req := withURLParam(newRequestAs(userID, "POST", "/api/agents/"+agentID+"/labels", map[string]any{"label_id": labelID}), "id", agentID)
		return testutil.Call(t, testHandler.AttachLabelToAgent, req)
	}
	attach(memberID, plainLabel).Want(http.StatusOK)
	attach(memberID, gatedLabel).Want(http.StatusForbidden)
	attach(testUserID, gatedLabel).Want(http.StatusOK)
}

// The agent's Skills and MCP tabs show what reaches the agent from projects,
// per each project's audience.
func TestListAgentProjectItems_FollowsAudience(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectA := dbfx.Project(t, "Agent view A")
	projectB := dbfx.Project(t, "Agent view B")
	for _, p := range []string{projectA, projectB} {
		dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, p)
		dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, p)
		dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, p)
	}
	viewer := newAudienceAgent(t, ctx, "agent-view-viewer", projectA)
	other := newAudienceAgent(t, ctx, "agent-view-other", projectA)

	shared := insertProjectSkillFixtureSkill(t, testWorkspaceID, "agent-view-shared")
	restricted := insertProjectSkillFixtureSkill(t, testWorkspaceID, "agent-view-restricted")
	addProjectSkillCall(t, projectA, shared, restricted).Want(http.StatusOK)
	addProjectSkillCall(t, projectB, shared).Want(http.StatusOK)
	setAudienceCall(t, "skills", projectA, restricted, map[string]any{
		"restricted": true, "agent_ids": []string{other.agentID},
	}).Want(http.StatusOK)
	serverID := createWorkspaceMcpServerForTest(t, "agent-view-mcp", `{"url":"https://agent-view.example"}`)
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE item_id = $1`, serverID)
	addProjectMcpServerCall(t, projectB, serverID).Want(http.StatusOK)

	req := withURLParam(newRequest("GET", "/api/agents/"+viewer.agentID+"/project-skills", nil), "id", viewer.agentID)
	var skills []AgentProjectSkillResponse
	testutil.Call(t, testHandler.ListAgentProjectSkills, req).Want(http.StatusOK).JSON(&skills)
	byID := map[string]AgentProjectSkillResponse{}
	for _, s := range skills {
		byID[s.ID] = s
	}
	if got := byID[shared]; len(got.Projects) != 2 {
		t.Fatalf("shared skill should come from both projects, got %+v", got.Projects)
	}
	if _, ok := byID[restricted]; ok {
		t.Fatal("a skill restricted to another agent was listed for this agent")
	}

	req = withURLParam(newRequest("GET", "/api/agents/"+viewer.agentID+"/project-mcp-servers", nil), "id", viewer.agentID)
	resp := testutil.Call(t, testHandler.ListAgentProjectMcpServers, req).Want(http.StatusOK)
	if strings.Contains(resp.Text(), "agent-view.example") {
		t.Fatalf("project MCP list leaked the server config: %s", resp.Text())
	}
	var servers []AgentProjectMcpServerResponse
	resp.JSON(&servers)
	if len(servers) != 1 || servers[0].ID != serverID || len(servers[0].Projects) != 1 || servers[0].Projects[0].ID != projectB {
		t.Fatalf("project MCP servers = %+v", servers)
	}
}

// An excluded link reaches every agent in the project except its audience:
// listed agents and agents carrying a listed label are left out, at claim,
// bundle-resolve and on the agent's own "From projects" list. With no targets
// it reaches everyone.
func TestProjectAttachmentAudience_ExcludesAudience(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience except")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)

	excluded := newAudienceAgent(t, ctx, "audience-except-listed", projectID)
	labelled := newAudienceAgent(t, ctx, "audience-except-labelled", projectID)
	included := newAudienceAgent(t, ctx, "audience-except-included", projectID)
	labelID := insertAgentLabel(t, "audience-except-interns")
	dbfx.Exec(t, `INSERT INTO agent_to_label (agent_id, label_id) VALUES ($1, $2)`, labelled.agentID, labelID)

	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "audience-except-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	var resp []ProjectSkillResponse
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"excluded": true, "agent_ids": []string{excluded.agentID}, "label_ids": []string{labelID},
	}).Want(http.StatusOK).JSON(&resp)
	if len(resp) != 1 || !resp[0].Audience.Excluded || resp[0].Audience.Restricted ||
		len(resp[0].Audience.AgentIDs) != 1 || len(resp[0].Audience.LabelIDs) != 1 {
		t.Fatalf("audience response = %+v", resp)
	}

	excludedTask := excluded.queueTask(t)
	if excluded.claimSkillIDs(t)[skillID] {
		t.Fatal("excluded agent received the skill")
	}
	resolveBundles(t, testHandler, excluded.runtimeID, excludedTask, workspaceRef(skillID)).Want(http.StatusNotFound)
	labelled.queueTask(t)
	if labelled.claimSkillIDs(t)[skillID] {
		t.Fatal("agent carrying an excluded label received the skill")
	}
	included.queueTask(t)
	if !included.claimSkillIDs(t)[skillID] {
		t.Fatal("agent outside the exclusion did not receive the skill")
	}

	listSkills := func(a audienceAgent) map[string]bool {
		req := withURLParam(newRequest("GET", "/api/agents/"+a.agentID+"/project-skills", nil), "id", a.agentID)
		var skills []AgentProjectSkillResponse
		testutil.Call(t, testHandler.ListAgentProjectSkills, req).Want(http.StatusOK).JSON(&skills)
		ids := map[string]bool{}
		for _, s := range skills {
			ids[s.ID] = true
		}
		return ids
	}
	if listSkills(excluded)[skillID] || !listSkills(included)[skillID] {
		t.Fatal("the agents' project skill lists do not follow the exclusion")
	}

	// The same rule holds for MCP servers.
	serverID := createWorkspaceMcpServerForTest(t, "audience-except-mcp", `{"url":"https://except.example"}`)
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE item_id = $1`, serverID)
	addProjectMcpServerCall(t, projectID, serverID).Want(http.StatusOK)
	setAudienceCall(t, "mcp-servers", projectID, serverID, map[string]any{
		"excluded": true, "agent_ids": []string{excluded.agentID},
	}).Want(http.StatusOK)
	excluded.queueTask(t)
	if decodeServers(t, claimAgentMcpConfigForTest(t, excluded.runtimeID))["audience-except-mcp"] != nil {
		t.Fatal("excluded agent received the MCP server")
	}
	included.queueTask(t)
	if decodeServers(t, claimAgentMcpConfigForTest(t, included.runtimeID))["audience-except-mcp"] == nil {
		t.Fatal("agent outside the exclusion did not receive the MCP server")
	}

	// Excluding nobody reaches everyone.
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{"excluded": true}).Want(http.StatusOK)
	excluded.queueTask(t)
	if !excluded.claimSkillIDs(t)[skillID] {
		t.Fatal("an exclusion with no targets did not reach every agent")
	}

	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"restricted": true, "excluded": true, "agent_ids": []string{excluded.agentID},
	}).Want(http.StatusBadRequest)
}

// Removing an excluded label from an agent hands it the item, so on an agent
// the owner manages, only a workspace admin may detach such a label.
func TestDetachLabelFromAgent_ExcludedLabelRequiresAdmin(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	projectID := dbfx.Project(t, "Audience detach gate")
	dbfx.Cleanup(t, `DELETE FROM project_attachment_audience WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM project_skill WHERE project_id = $1`, projectID)

	memberID := dbfx.User(t, "Detach gate member", "detach-gate-member@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	runtimeID := createClaimReclaimRuntime(t, ctx, "detach gate runtime")
	agentID := dbfx.Agent(t, "detach gate agent", runtimeID, testutil.Cols{"owner_id": memberID})
	dbfx.Cleanup(t, `DELETE FROM agent_to_label WHERE agent_id = $1`, agentID)

	plainLabel := insertAgentLabel(t, "detach-gate-plain")
	gatedLabel := insertAgentLabel(t, "detach-gate-interns")
	for _, l := range []string{plainLabel, gatedLabel} {
		dbfx.Exec(t, `INSERT INTO agent_to_label (agent_id, label_id) VALUES ($1, $2)`, agentID, l)
	}
	skillID := insertProjectSkillFixtureSkill(t, testWorkspaceID, "detach-gate-skill")
	addProjectSkillCall(t, projectID, skillID).Want(http.StatusOK)
	setAudienceCall(t, "skills", projectID, skillID, map[string]any{
		"excluded": true, "label_ids": []string{gatedLabel},
	}).Want(http.StatusOK)

	detach := func(userID, labelID string) *testutil.Response {
		req := withURLParams(newRequestAs(userID, "DELETE", "/api/agents/"+agentID+"/labels/"+labelID, nil),
			"id", agentID, "labelId", labelID)
		return testutil.Call(t, testHandler.DetachLabelFromAgent, req)
	}
	detach(memberID, plainLabel).Want(http.StatusOK)
	detach(memberID, gatedLabel).Want(http.StatusForbidden)
	detach(testUserID, gatedLabel).Want(http.StatusOK)
}
