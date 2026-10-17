package handler

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestAgentWakeupRejection(t *testing.T) {
	const agent, other = "01900000-0000-7000-8000-0000000000a1", "01900000-0000-7000-8000-0000000000b2"
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	allow := []string{other, strings.ToUpper(agent)}
	hours := func(h int64) int64 { return h * 3600 }
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }
	cond := func(raw string) json.RawMessage { return json.RawMessage(raw) }
	for _, tc := range []struct {
		name    string
		in      service.WakeupInput
		timers  []string
		pending bool
		want    string
	}{
		{"at", service.WakeupInput{AgentID: agent, Kind: "at", AfterSeconds: hours(13)}, nil, false, agentTimerRejection},
		{"at other allowlisted", service.WakeupInput{AgentID: agent, Kind: "at", AfterSeconds: hours(13)}, []string{other}, false, agentTimerRejection},
		{"at allowlisted 13 h", service.WakeupInput{AgentID: agent, Kind: "at", AfterSeconds: hours(13)}, allow, false, ""},
		{"at allowlisted absolute 13 h", service.WakeupInput{AgentID: agent, Kind: "at", At: at(13 * time.Hour)}, allow, false, ""},
		{"at allowlisted 8 h", service.WakeupInput{AgentID: agent, Kind: "at", AfterSeconds: hours(8)}, allow, false, agentTimerSoonRejection},
		{"at allowlisted absolute 8 h", service.WakeupInput{AgentID: agent, Kind: "at", At: at(8 * time.Hour)}, allow, false, agentTimerSoonRejection},
		{"at allowlisted past", service.WakeupInput{AgentID: agent, Kind: "at", At: at(-time.Hour)}, allow, false, agentTimerSoonRejection},
		{"at allowlisted no time", service.WakeupInput{AgentID: agent, Kind: "at"}, allow, false, agentTimerSoonRejection},
		{"at allowlisted for another agent", service.WakeupInput{AgentID: other, Kind: "at", AfterSeconds: hours(13)}, allow, false, agentTimerOwnRejection},
		{"at allowlisted second timer", service.WakeupInput{AgentID: agent, Kind: "at", AfterSeconds: hours(13)}, allow, true, agentTimerPendingRejection},
		{"event no types", service.WakeupInput{Kind: "event"}, nil, false, agentEventRejection},
		{"event null condition", service.WakeupInput{Kind: "event", Condition: cond("null")}, nil, false, agentEventRejection},
		{"event comment.created", service.WakeupInput{Kind: "event", EventTypes: []string{"comment.created"}}, nil, false, agentEventRejection},
		{"event task.completed", service.WakeupInput{Kind: "event", EventTypes: []string{"issue.status_changed", "task.completed"}}, nil, false, agentEventRejection},
		{"event issue type", service.WakeupInput{Kind: "event", EventTypes: []string{"issue.status_changed"}}, nil, false, ""},
		{"until pr checks", service.WakeupInput{Kind: "event", Condition: cond(`{"type":"pull_request","event":"checks_finished"}`)}, nil, false, ""},
		{"until pr merged", service.WakeupInput{Kind: "event", Condition: cond(`{"type":"pull_request","event":"merged"}`)}, nil, false, ""},
		{"until issue", service.WakeupInput{Kind: "event", Condition: cond(`{"type":"other_issue","issue_id":"01900000-0000-7000-8000-0000000000c3","state":"done"}`)}, nil, false, ""},
		{"until children done", service.WakeupInput{Kind: "event", Condition: cond(`{"type":"children_done","stage":1}`)}, nil, false, ""},
		{"until status", service.WakeupInput{Kind: "event", Condition: cond(`{"type":"issue_field","field":"status","value":"in_review"}`)}, nil, false, ""},
		{"stored condition hints", service.WakeupInput{Kind: "event", EventTypes: []string{"task.completed"}, Condition: cond(`{"type":"children_done"}`)}, nil, false, ""},
		{"every", service.WakeupInput{Kind: "every", IntervalSeconds: 3600}, nil, false, ""},
		{"cron", service.WakeupInput{Kind: "cron", CronExpression: "0 9 * * *"}, nil, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := agentWakeupRejection(tc.in, agent, tc.timers, now, tc.pending); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// agentPolicyFixture is an issue with a running task of its agent, so requests
// can act as that agent's run.
func agentPolicyFixture(t *testing.T, name string) (issue, agent, run string) {
	t.Helper()
	issue = dbfx.Issue(t, name)
	agent = dbfx.Agent(t, name, testRuntimeID)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issue)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id IN(SELECT id FROM issue_wakeup WHERE issue_id=$1)", issue)
	run = dbfx.Task(t, agent, testutil.Cols{"runtime_id": testRuntimeID, "issue_id": issue, "status": "running", "started_at": testutil.Raw("now()"), "originator_user_id": testUserID, "accountable_user_id": testUserID})
	return issue, agent, run
}

func TestAgentWakeupPolicyEndpoints(t *testing.T) {
	issue, agent, run := agentPolicyFixture(t, "agent wakeup policy")
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	timer := map[string]any{"kind": "at", "after_seconds": 600, "instruction": "check again"}
	rows := func() int { return dbfx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE issue_id=$1", issue) }
	enable := func(rule db.IssueWakeup, revision int64, want int) string {
		t.Helper()
		req := withURLParams(newRequest("POST", "/", map[string]any{"revision": revision}), "id", issue, "wakeupID", uuidToString(rule.ID))
		return testutil.Call(t, testHandler.EnableIssueWakeup, actAsRun(req, agent, run)).Want(want).Text()
	}
	disabled := func(in service.WakeupInput) db.IssueWakeup {
		t.Helper()
		in.AgentID, in.Instruction = agent, "member rule"
		rule, err := svc.Create(context.Background(), parseUUID(issue), parseUUID(testUserID), pgtype.UUID{}, in)
		if err != nil {
			t.Fatal(err)
		}
		if rule, err = svc.Disable(context.Background(), parseUUID(issue), rule.ID, parseUUID(testUserID)); err != nil {
			t.Fatal(err)
		}
		return rule
	}

	// MAIN-1761: an agent's own timer is refused and nothing is stored.
	rec := testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(withURLParam(newRequest("POST", "/", timer), "id", issue), agent, run)).Want(400)
	if !strings.Contains(rec.Text(), "agents cannot create time wakeups") || rows() != 0 {
		t.Fatalf("agent timer: %s (rows %d)", rec.Text(), rows())
	}
	rec = testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(withURLParam(newRequest("POST", "/", map[string]any{"kind": "event", "event_types": []string{"comment.created"}, "instruction": "reply"}), "id", issue), agent, run)).Want(400)
	if !strings.Contains(rec.Text(), "agents cannot create next-comment") || rows() != 0 {
		t.Fatalf("agent comment wakeup: %s (rows %d)", rec.Text(), rows())
	}

	// Members keep timers.
	testutil.Call(t, testHandler.CreateIssueWakeup, withURLParam(newRequest("POST", "/", map[string]any{"agent_id": agent, "kind": "at", "after_seconds": 600, "instruction": "member timer"}), "id", issue)).Want(201)

	// A condition is the supported way for an agent to wait.
	var pr db.IssueWakeup
	testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(withURLParam(newRequest("POST", "/", map[string]any{"kind": "event", "condition": map[string]any{"type": "pull_request", "event": "checks_finished"}, "instruction": "review checks"}), "id", issue), agent, run)).Want(201).JSON(&pr)
	if pr.Kind != "event" || len(pr.Condition) == 0 {
		t.Fatalf("condition rule not stored: %+v", pr)
	}

	// Replacing an event rule with a timer is a create in disguise.
	rec = testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(withURLParams(newRequest("PUT", "/", timer), "id", issue, "wakeupID", uuidToString(pr.ID)), agent, run)).Want(400)
	if !strings.Contains(rec.Text(), "agents cannot create time wakeups") {
		t.Fatalf("agent replace: %s", rec.Text())
	}
	var kind string
	dbfx.QueryRow(t, "SELECT kind FROM issue_wakeup WHERE id=$1", pr.ID).Scan(&kind)
	if kind != "event" {
		t.Fatalf("replaced kind %q", kind)
	}

	// Re-enabling a stored rule is held to the create rules.
	at := disabled(service.WakeupInput{Kind: "at", AfterSeconds: 600})
	if body := enable(at, at.Revision, 400); !strings.Contains(body, "agents cannot create time wakeups") {
		t.Fatalf("agent enable timer: %s", body)
	}
	comment := disabled(service.WakeupInput{Kind: "event", EventTypes: []string{"comment.created"}})
	if body := enable(comment, comment.Revision, 400); !strings.Contains(body, "agents cannot create next-comment") {
		t.Fatalf("agent enable comment rule: %s", body)
	}
	var enabledCount int
	dbfx.QueryRow(t, "SELECT count(*) FROM issue_wakeup WHERE id IN($1,$2) AND enabled", at.ID, comment.ID).Scan(&enabledCount)
	if enabledCount != 0 {
		t.Fatal("agent re-enabled a refused rule")
	}
	// A stale revision is a conflict, as Enable itself would answer.
	enable(comment, comment.Revision+1, 409)
	conditioned := disabled(service.WakeupInput{Kind: "event", Condition: json.RawMessage(`{"type":"issue_field","field":"status","value":"in_review"}`)})
	enable(conditioned, conditioned.Revision, 200)
	// System rules stay the platform's, whatever their events.
	var system db.IssueWakeup
	dbfx.QueryRow(t, `INSERT INTO issue_wakeup (id, workspace_id, issue_id, instruction, kind, mode, event_types, system_rule, enabled)
		VALUES (gen_random_uuid(), $1, $2, 'stage closed', 'event', 'continuous', ARRAY['comment.created'], 'child_done', false)
		RETURNING id, revision`, testWorkspaceID, issue).Scan(&system.ID, &system.Revision)
	enable(system, system.Revision, 403)
}

func TestAgentWakeupTimerAllowlist(t *testing.T) {
	issue, agent, run := agentPolicyFixture(t, "agent timer allowlist")
	peer := dbfx.Agent(t, "agent timer peer", testRuntimeID)
	timerAgents := testHandler.cfg.AgentTimerAgentIDs
	t.Cleanup(func() { testHandler.cfg.AgentTimerAgentIDs = timerAgents })
	testHandler.cfg.AgentTimerAgentIDs = []string{agent, peer}
	timer := func(hours int64, extra ...any) map[string]any {
		body := map[string]any{"kind": "at", "after_seconds": hours * 3600, "instruction": "check the vendor advisory"}
		for i := 0; i+1 < len(extra); i += 2 {
			body[extra[i].(string)] = extra[i+1]
		}
		return body
	}
	post := func(body map[string]any, want int) *testutil.Response {
		t.Helper()
		return testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(withURLParam(newRequest("POST", "/", body), "id", issue), agent, run)).Want(want)
	}

	if body := post(timer(8), 400).Text(); !strings.Contains(body, "at least 12 h out") {
		t.Fatalf("8 h timer: %s", body)
	}
	if body := post(timer(13, "agent_id", peer), 400).Text(); !strings.Contains(body, "only for themselves") {
		t.Fatalf("timer for a peer: %s", body)
	}
	// A member's reminder for the agent does not count as its pending timer.
	testutil.Call(t, testHandler.CreateIssueWakeup, withURLParam(newRequest("POST", "/", timer(1, "agent_id", agent)), "id", issue)).Want(201)
	var first db.IssueWakeup
	post(timer(13), 201).JSON(&first)
	if body := post(timer(13), 400).Text(); !strings.Contains(body, "only one pending time wakeup") {
		t.Fatalf("second timer: %s", body)
	}
	// Replacing the pending timer itself is allowed, but not to a sooner time.
	put := func(body map[string]any, want int) {
		t.Helper()
		req := withURLParams(newRequest("PUT", "/", body), "id", issue, "wakeupID", uuidToString(first.ID))
		testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(req, agent, run)).Want(want)
	}
	put(timer(14), 200)
	put(timer(1), 400)
	if n := dbfx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE issue_id=$1 AND source_task_id IS NOT NULL", issue); n != 1 {
		t.Fatalf("stored %d timers", n)
	}
}

func TestAgentWakeupTimerAllowlistEnable(t *testing.T) {
	issue, agent, run := agentPolicyFixture(t, "agent timer allowlist enable")
	peer := dbfx.Agent(t, "agent timer enable peer", testRuntimeID)
	timerAgents := testHandler.cfg.AgentTimerAgentIDs
	t.Cleanup(func() { testHandler.cfg.AgentTimerAgentIDs = timerAgents })
	testHandler.cfg.AgentTimerAgentIDs = []string{agent, peer}
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	ctx := context.Background()
	// disabledTimer is a member's timer for target, turned off, firing in
	// hours once re-enabled without a new time.
	disabledTimer := func(target string, hours int) db.IssueWakeup {
		t.Helper()
		rule, err := svc.Create(ctx, parseUUID(issue), parseUUID(testUserID), pgtype.UUID{}, service.WakeupInput{AgentID: target, Kind: "at", AfterSeconds: 13 * 3600, Instruction: "member timer"})
		if err != nil {
			t.Fatal(err)
		}
		if rule, err = svc.Disable(ctx, parseUUID(issue), rule.ID, parseUUID(testUserID)); err != nil {
			t.Fatal(err)
		}
		dbfx.Exec(t, "UPDATE issue_wakeup SET next_fire_at=now()+make_interval(hours=>$2) WHERE id=$1", rule.ID, hours)
		return rule
	}
	enable := func(rule db.IssueWakeup, body map[string]any, want int) string {
		t.Helper()
		body["revision"] = rule.Revision
		req := withURLParams(newRequest("POST", "/", body), "id", issue, "wakeupID", uuidToString(rule.ID))
		return testutil.Call(t, testHandler.EnableIssueWakeup, actAsRun(req, agent, run)).Want(want).Text()
	}

	soon := disabledTimer(agent, 8)
	if body := enable(soon, map[string]any{}, 400); !strings.Contains(body, "at least 12 h out") {
		t.Fatalf("stored 8 h: %s", body)
	}
	// A new time at least 12 h out may re-enable it; the run makes it the
	// agent's own timer.
	enable(soon, map[string]any{"at": time.Now().Add(13 * time.Hour).UTC().Format(time.RFC3339)}, 200)
	other := disabledTimer(agent, 13)
	if body := enable(other, map[string]any{}, 400); !strings.Contains(body, "only one pending time wakeup") {
		t.Fatalf("second timer: %s", body)
	}
	peers := disabledTimer(peer, 13)
	if body := enable(peers, map[string]any{}, 400); !strings.Contains(body, "only for themselves") {
		t.Fatalf("peer timer: %s", body)
	}
	// A disabled agent-created timer is not pending.
	if _, err := svc.Disable(ctx, parseUUID(issue), soon.ID, parseUUID(testUserID)); err != nil {
		t.Fatal(err)
	}
	req := withURLParam(newRequest("POST", "/", map[string]any{"kind": "at", "after_seconds": 13 * 3600, "instruction": "check the vendor advisory"}), "id", issue)
	testutil.Call(t, testHandler.CreateIssueWakeup, actAsRun(req, agent, run)).Want(201)
}
