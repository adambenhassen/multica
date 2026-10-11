package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

const projectMcpSecret = "project-mcp-secret-token"

func addProjectMcpServerCall(t *testing.T, projectID string, serverIDs ...string) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest("POST", "/api/projects/"+projectID+"/mcp-servers", map[string]any{
		"server_ids": serverIDs,
	}), "id", projectID)
	return testutil.Call(t, testHandler.AddProjectMcpServers, req)
}

func projectMcpServerCount(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	dbfx.QueryRow(t, `SELECT count(*) FROM project_mcp_server WHERE `+where, args...).Scan(&n)
	return n
}

func TestProjectMcpServerLifecycle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Project MCP lifecycle")
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)
	serverID := createWorkspaceMcpServerForTest(t, "project-mcp-lifecycle",
		`{"url":"https://mcp.example","headers":{"Authorization":"Bearer `+projectMcpSecret+`"}}`)

	resp := addProjectMcpServerCall(t, projectID, serverID).Want(http.StatusOK)
	if strings.Contains(resp.Text(), projectMcpSecret) || strings.Contains(resp.Text(), "mcp.example") {
		t.Fatalf("add response leaked the server config: %s", resp.Text())
	}
	var added []WorkspaceMcpServerResponse
	resp.JSON(&added)
	if len(added) != 1 || added[0].ID != serverID || added[0].Transport != "http" {
		t.Fatalf("add returned %+v, want server %s", added, serverID)
	}
	// Re-attaching is a no-op, not a conflict.
	addProjectMcpServerCall(t, projectID, serverID, serverID).Want(http.StatusOK)
	addProjectMcpServerCall(t, projectID).Want(http.StatusBadRequest)

	req := withURLParam(newRequest("GET", "/api/projects/"+projectID+"/mcp-servers", nil), "id", projectID)
	listed := testutil.Call(t, testHandler.ListProjectMcpServers, req).Want(http.StatusOK)
	if strings.Contains(listed.Text(), projectMcpSecret) {
		t.Fatalf("list leaked the server config: %s", listed.Text())
	}

	// The library listing counts project attachments so an entry used only by
	// projects does not look unused.
	req = withURLParam(newRequest("GET", "/api/workspaces/"+testWorkspaceID+"/mcp-servers", nil), "id", testWorkspaceID)
	var library []WorkspaceMcpServerResponse
	testutil.Call(t, testHandler.ListWorkspaceMcpServers, req).Want(http.StatusOK).JSON(&library)
	for _, entry := range library {
		if entry.ID == serverID && (entry.ProjectCount == nil || *entry.ProjectCount != 1) {
			t.Fatalf("library project_count = %v, want 1", entry.ProjectCount)
		}
	}

	remove := func() *testutil.Response {
		req := withURLParams(newRequest("DELETE", "/api/projects/"+projectID+"/mcp-servers/"+serverID, nil),
			"id", projectID, "serverId", serverID)
		return testutil.Call(t, testHandler.RemoveProjectMcpServer, req)
	}
	remove().Want(http.StatusNoContent)
	remove().Want(http.StatusNotFound)
	if n := projectMcpServerCount(t, "project_id = $1", projectID); n != 0 {
		t.Fatalf("%d rows left after removal", n)
	}
}

// Project servers carry credentials onto every runtime that runs project work,
// so only human owners and admins may attach them, and only from the
// project's own workspace library.
func TestProjectMcpServer_AccessRules(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Project MCP access")
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)
	serverID := createWorkspaceMcpServerForTest(t, "project-mcp-access", `{"url":"https://access.example"}`)

	memberID := dbfx.User(t, "Project MCP member", "project-mcp-member@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	req := withURLParam(newRequestAs(memberID, "POST", "/api/projects/"+projectID+"/mcp-servers", map[string]any{
		"server_ids": []string{serverID},
	}), "id", projectID)
	testutil.Call(t, testHandler.AddProjectMcpServers, req).Want(http.StatusForbidden)

	req = withURLParam(newRequest("POST", "/api/projects/"+projectID+"/mcp-servers", map[string]any{
		"server_ids": []string{serverID},
	}), "id", projectID)
	req.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, testHandler.AddProjectMcpServers, req).Want(http.StatusForbidden)

	foreignWorkspaceID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "Foreign project MCP",
		"slug":         "foreign-project-mcp-ws",
		"description":  "",
		"issue_prefix": "FPM",
	})
	foreignServerID := dbfx.Insert(t, "workspace_mcp_server", testutil.Cols{
		"workspace_id": foreignWorkspaceID,
		"name":         "foreign",
		"config":       `{"url":"https://foreign.example"}`,
	})
	// A batch with one foreign id attaches nothing.
	addProjectMcpServerCall(t, projectID, serverID, foreignServerID).Want(http.StatusNotFound)
	if n := projectMcpServerCount(t, "project_id = $1", projectID); n != 0 {
		t.Fatalf("foreign batch attached %d rows", n)
	}

	addProjectMcpServerCall(t, projectID, serverID).Want(http.StatusOK)
	req = withURLParams(newRequestAs(memberID, "DELETE", "/api/projects/"+projectID+"/mcp-servers/"+serverID, nil),
		"id", projectID, "serverId", serverID)
	testutil.Call(t, testHandler.RemoveProjectMcpServer, req).Want(http.StatusForbidden)
	req = withURLParam(newRequestAs(memberID, "GET", "/api/projects/"+projectID+"/mcp-servers", nil), "id", projectID)
	testutil.Call(t, testHandler.ListProjectMcpServers, req).Want(http.StatusOK)
}

// project_mcp_server has no foreign keys, so deleting the library entry or the
// project must remove the link.
func TestProjectMcpServer_RemovedWithServerAndProject(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	projectID := dbfx.Project(t, "Project MCP cleanup")
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)

	serverID := createWorkspaceMcpServerForTest(t, "project-mcp-cleanup-server", `{"url":"https://cleanup.example"}`)
	addProjectMcpServerCall(t, projectID, serverID).Want(http.StatusOK)
	req := withURLParams(newRequest(http.MethodDelete, "/api/workspaces/"+testWorkspaceID+"/mcp-servers/"+serverID, nil),
		"id", testWorkspaceID, "serverId", serverID)
	testutil.Call(t, testHandler.DeleteWorkspaceMcpServer, req).Want(http.StatusNoContent)
	if n := projectMcpServerCount(t, "server_id = $1", serverID); n != 0 {
		t.Fatalf("library delete left %d project links", n)
	}

	otherServerID := createWorkspaceMcpServerForTest(t, "project-mcp-cleanup-project", `{"url":"https://cleanup2.example"}`)
	addProjectMcpServerCall(t, projectID, otherServerID).Want(http.StatusOK)
	req = withURLParam(newRequest("DELETE", "/api/projects/"+projectID, nil), "id", projectID)
	testutil.Call(t, testHandler.DeleteProject, req).Want(http.StatusNoContent)
	if n := projectMcpServerCount(t, "project_id = $1", projectID); n != 0 {
		t.Fatalf("project delete left %d links", n)
	}
}

// A task in a project runs with the project's MCP servers alongside the
// agent's own. The agent's own entry wins a name clash, and a server the agent
// has bound but disabled stays off.
func TestClaimTask_DeliversProjectMcpServers(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	runtimeID := createClaimReclaimRuntime(t, ctx, "Project MCP runtime")
	agentID, issueID := createClaimReclaimAgentAndIssue(t, ctx, runtimeID, "Project MCP agent")
	projectID := dbfx.Project(t, "Project MCP claim")
	dbfx.Cleanup(t, `DELETE FROM project_mcp_server WHERE project_id = $1`, projectID)
	dbfx.Cleanup(t, `DELETE FROM agent_mcp_server WHERE agent_id = $1`, agentID)
	dbfx.Exec(t, `UPDATE issue SET project_id = $1 WHERE id = $2`, projectID, issueID)
	dbfx.Exec(t, `UPDATE agent SET mcp_config = $1 WHERE id = $2`,
		[]byte(`{"mcpServers":{"pm-shadowed":{"url":"https://agent-own.example"}}}`), agentID)

	projectServer := createWorkspaceMcpServerForTest(t, "pm-project", `{"url":"https://project.example"}`)
	shadowed := createWorkspaceMcpServerForTest(t, "pm-shadowed", `{"url":"https://library.example"}`)
	disabled := createWorkspaceMcpServerForTest(t, "pm-disabled", `{"url":"https://disabled.example"}`)
	dbfx.Exec(t, `INSERT INTO agent_mcp_server (agent_id, server_id, enabled) VALUES ($1, $2, FALSE)`, agentID, disabled)
	addProjectMcpServerCall(t, projectID, projectServer, shadowed, disabled).Want(http.StatusOK)

	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID})

	servers := decodeServers(t, claimAgentMcpConfigForTest(t, runtimeID))
	if servers["pm-project"] == nil {
		t.Fatalf("project server missing from claim: %v", serverNames(servers))
	}
	if servers["pm-disabled"] != nil {
		t.Fatalf("a server the agent disabled reached the claim through the project: %v", serverNames(servers))
	}
	own, _ := servers["pm-shadowed"].(map[string]any)
	if own["url"] != "https://agent-own.example" {
		t.Fatalf("agent's own entry should win the name clash, got %v", servers["pm-shadowed"])
	}
}
