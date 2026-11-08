package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExtractTranscriptRequests(t *testing.T) {
	dir := t.TempDir()
	main := `{"type":"user","sessionId":"s1","timestamp":"2026-10-20T10:00:00Z","message":{"content":"secret prompt"}}
{"type":"assistant","sessionId":"s1","requestId":"req_1","timestamp":"2026-10-20T10:00:01Z","message":{"id":"msg_1","model":"claude-haiku-5-5","usage":{"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":9403,"cache_creation_input_tokens":14143,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":14143}}}}
{"type":"assistant","sessionId":"s1","requestId":"req_1","timestamp":"2026-10-20T10:00:02Z","message":{"id":"msg_1","model":"claude-haiku-5-5","usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":9403,"cache_creation_input_tokens":14143,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":14143}}}}
{"type":"assistant","sessionId":"s1","requestId":"req_2","timestamp":"2026-10-20T10:01:00Z","message":{"id":"msg_2","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":40}}}
not json
`
	// Subagent transcripts carry the parent session id and may lack requestId.
	sub := `{"type":"assistant","sessionId":"s1","requestId":null,"timestamp":"2026-10-20T10:02:00Z","message":{"id":"msg_3","model":"claude-haiku-5-5","usage":{"input_tokens":5,"output_tokens":6}}}
`
	if err := os.MkdirAll(filepath.Join(dir, "proj", "s1", "subagents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "proj", "s1.jsonl"), []byte(main), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "proj", "s1", "subagents", "agent-a.jsonl"), []byte(sub), 0o600); err != nil {
		t.Fatal(err)
	}
	// A worktree migration copies a transcript into another project dir.
	if err := os.MkdirAll(filepath.Join(dir, "copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "copy", "s1.jsonl"), []byte(main), 0o600); err != nil {
		t.Fatal(err)
	}

	reqs, err := extractRequests(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]transcriptRequest{}
	for _, r := range reqs {
		got[r.Key] = r
	}
	if len(reqs) != 3 || len(got) != 3 {
		t.Fatalf("requests = %+v; want req_1, req_2, msg_3 once each", reqs)
	}
	if r := got["req_1"]; r.Output != 4 || r.CacheWrite1h != 14143 || r.CacheWrite5m != 0 || r.CacheRead != 9403 || r.SessionID != "s1" {
		t.Errorf("req_1 = %+v; want the last streamed copy with its 1h writes", r)
	}
	if r := got["req_2"]; r.CacheWrite5m != 40 || r.CacheWrite1h != 0 {
		t.Errorf("req_2 = %+v; unsplit writes count as 5m", r)
	}
	if r := got["msg_3"]; r.Input != 5 || r.Model != "claude-haiku-5-5" {
		t.Errorf("msg_3 = %+v", r)
	}
	for _, r := range reqs {
		if strings.Contains(r.Model+r.Key+r.SessionID, "secret") {
			t.Fatalf("extract leaked transcript content: %+v", r)
		}
	}
}

func TestAssignRequestsToTasks(t *testing.T) {
	at := func(s string) time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	// One resumed session served two tasks; another task is still running.
	tasks := []taskWindow{
		{ID: "first", Sessions: []string{"s1"}, Start: at("2026-10-20T10:00:00Z"), End: at("2026-10-20T10:30:00Z")},
		{ID: "second", Sessions: []string{"s1"}, Start: at("2026-10-20T12:00:00Z"), End: at("2026-10-20T12:30:00Z")},
		{ID: "running", Sessions: []string{"s2"}, Start: at("2026-10-21T09:00:00Z")},
	}
	reqs := []transcriptRequest{
		{SessionID: "s1", Key: "a", Time: at("2026-10-20T10:05:00Z")},
		{SessionID: "s1", Key: "b", Time: at("2026-10-20T12:10:00Z")},
		{SessionID: "s1", Key: "between", Time: at("2026-10-20T11:00:00Z")},
		{SessionID: "s2", Key: "c", Time: at("2026-10-21T10:00:00Z")},
		{SessionID: "unknown", Key: "d", Time: at("2026-10-21T10:00:00Z")},
	}
	byTask, unmatched := assignRequests(reqs, tasks, 2*time.Minute)
	if unmatched != 2 {
		t.Errorf("unmatched = %d, want 2", unmatched)
	}
	keys := func(id string) string {
		var out []string
		for _, r := range byTask[id] {
			out = append(out, r.Key)
		}
		return strings.Join(out, ",")
	}
	if keys("first") != "a" || keys("second") != "b" || keys("running") != "c" {
		t.Fatalf("assigned first=%q second=%q running=%q", keys("first"), keys("second"), keys("running"))
	}
}
