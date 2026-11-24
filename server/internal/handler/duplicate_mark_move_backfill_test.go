package handler

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Migration 622 fills in the status move on duplicate marks recorded before
// the mark row carried it, so the activity feed shows those issues cancelled.
//
// The shipped SQL runs twice inside a transaction that is rolled back: the
// UPDATE is table-wide, and committing it would rewrite rows other packages'
// tests build concurrently in the same database.
func TestMigration622BackfillsDuplicateMarkMoves(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	ws := dbfx.Workspace(t, "Duplicate move backfill", "dup-move-backfill-"+uuid.NewString(), testutil.Cols{"issue_prefix": "DMB"})
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	issue := func() string {
		return dbfx.Issue(t, "Backfilled duplicate", testutil.Cols{"workspace_id": ws, "status": "cancelled"})
	}
	insert := func(issueID, action, details string, minute int) string {
		return dbfx.Insert(t, "activity_log", testutil.Cols{
			"workspace_id": ws, "issue_id": issueID, "actor_type": "member", "actor_id": testUserID,
			"action": action, "details": details, "created_at": base.Add(time.Duration(minute) * time.Minute),
		})
	}
	const original = `{"original_id":"x","original_identifier":"DMB-99"}`

	moved := issue()
	insert(moved, "created", `{}`, 0)
	insert(moved, "status_changed", `{"from":"todo","to":"in_progress"}`, 1)
	movedMark := insert(moved, "duplicate_marked", original, 2)

	neverMoved := issue()
	insert(neverMoved, "created", `{}`, 0)
	neverMovedMark := insert(neverMoved, "duplicate_marked", original, 1)

	alreadyCancelled := issue()
	insert(alreadyCancelled, "status_changed", `{"from":"todo","to":"cancelled"}`, 0)
	alreadyCancelledMark := insert(alreadyCancelled, "duplicate_marked", original, 1)

	// Marked, then moved to another original: the second mark moved nothing.
	repointed := issue()
	insert(repointed, "status_changed", `{"from":"backlog","to":"todo"}`, 0)
	firstMark := insert(repointed, "duplicate_marked", original, 1)
	insert(repointed, "duplicate_unmarked", original, 2)
	secondMark := insert(repointed, "duplicate_marked", `{"original_id":"y","original_identifier":"DMB-98"}`, 3)

	// Reopened by removing the mark, then marked again.
	remarked := issue()
	insert(remarked, "duplicate_marked", original, 0)
	insert(remarked, "duplicate_unmarked", `{"original_id":"x","original_identifier":"DMB-99","to":"in_review"}`, 1)
	remark := insert(remarked, "duplicate_marked", original, 2)

	current := insert(issue(), "duplicate_marked", `{"original_id":"x","original_identifier":"DMB-99","from":"backlog","to":"cancelled"}`, 0)

	migration, err := os.ReadFile("../../migrations/622_duplicate_mark_status_move.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for range 2 {
		if _, err := tx.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
	}
	detailsOf := func(id string) map[string]string {
		t.Helper()
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT details FROM activity_log WHERE id = $1`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var out map[string]string
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	with := func(move map[string]string) map[string]string {
		out := map[string]string{"original_id": "x", "original_identifier": "DMB-99"}
		maps.Copy(out, move)
		return out
	}
	for _, tc := range []struct {
		name, id string
		want     map[string]string
	}{
		{"a mark after a move takes its from", movedMark, with(map[string]string{"from": "in_progress", "to": "cancelled"})},
		{"a mark with no earlier move takes only its to", neverMovedMark, with(map[string]string{"to": "cancelled"})},
		{"a mark on a cancelled issue moved nothing", alreadyCancelledMark, with(nil)},
		{"the first mark moved the issue", firstMark, with(map[string]string{"from": "todo", "to": "cancelled"})},
		{"a repointed mark moved nothing", secondMark, map[string]string{"original_id": "y", "original_identifier": "DMB-98"}},
		{"a mark after a reopening unmark takes its to", remark, with(map[string]string{"from": "in_review", "to": "cancelled"})},
		{"a mark that carries its move is left alone", current, with(map[string]string{"from": "backlog", "to": "cancelled"})},
	} {
		if got := detailsOf(tc.id); !maps.Equal(got, tc.want) {
			t.Errorf("%s: details = %v, want %v", tc.name, got, tc.want)
		}
	}
}
