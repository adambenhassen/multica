-- A duplicate mark that cancelled an issue stands in for its status row
-- (MUL-7349), but marks recorded before the row carried the move have no `to`,
-- so the activity feed never shows those issues leaving their old status. This
-- fills in the move. The status before a mark is the issue's latest earlier
-- move; a duplicate mark is always a move into cancelled. A mark on an issue
-- that was already cancelled moved nothing and stays as it is. An issue with
-- no earlier move left its creation status, which is not on record, so only
-- `to` is filled.
WITH marks AS (
    SELECT m.id,
           (SELECT CASE WHEN p.action = 'duplicate_marked' THEN 'cancelled' ELSE p.details->>'to' END
            FROM activity_log p
            WHERE p.issue_id = m.issue_id
              AND (p.created_at, p.id) < (m.created_at, m.id)
              AND (p.action = 'duplicate_marked'
                   OR (p.action IN ('status_changed', 'duplicate_unmarked') AND p.details ? 'to'))
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT 1) AS prev_status
    FROM activity_log m
    WHERE m.action = 'duplicate_marked' AND NOT m.details ? 'to'
)
UPDATE activity_log a
SET details = a.details || jsonb_strip_nulls(jsonb_build_object('from', marks.prev_status, 'to', 'cancelled'))
FROM marks
WHERE a.id = marks.id AND marks.prev_status IS DISTINCT FROM 'cancelled';
