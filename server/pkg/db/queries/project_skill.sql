-- Project-Skill junction

-- name: ListProjectSkillsForAgent :many
-- Full skill rows for the daemon claim path. Both sides are workspace-scoped,
-- so a corrupt project reference cannot lift another tenant's skill into a run.
-- A skill the agent has attached but disabled stays off: the agent owner's
-- opt-out wins over the project attachment.
SELECT s.* FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = sqlc.arg('project_id')
  AND ps.workspace_id = sqlc.arg('workspace_id')
  AND s.workspace_id = sqlc.arg('workspace_id')
  AND NOT EXISTS (
    SELECT 1 FROM agent_skill ask
    WHERE ask.agent_id = sqlc.arg('agent_id')
      AND ask.skill_id = s.id
      AND ask.enabled = FALSE
  )
ORDER BY s.name ASC;

-- name: ListProjectSkillsForAgentByIDs :many
-- Scoped variant of ListProjectSkillsForAgent for the skill-bundle resolve
-- path, with the same agent opt-out. The junction predicate is the
-- authorization: a skill not attached to the project returns no row, which the
-- caller reports as not-found.
SELECT s.* FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = sqlc.arg('project_id')
  AND ps.workspace_id = sqlc.arg('workspace_id')
  AND s.workspace_id = sqlc.arg('workspace_id')
  AND s.id = ANY(sqlc.arg('skill_ids')::uuid[])
  AND NOT EXISTS (
    SELECT 1 FROM agent_skill ask
    WHERE ask.agent_id = sqlc.arg('agent_id')
      AND ask.skill_id = s.id
      AND ask.enabled = FALSE
  )
ORDER BY s.name ASC;

-- name: ListProjectSkillSummaries :many
-- Summary variant for the project skills list endpoint — omits `content`.
SELECT s.id, s.workspace_id, s.name, s.description, s.config, s.created_by, s.created_at, s.updated_at
FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = $1
  AND ps.workspace_id = $2
  AND s.workspace_id = $2
ORDER BY s.name ASC;

-- name: LockSkillsInWorkspace :many
-- Validates skills inside the attach transaction. Skill deletes lock the row
-- FOR UPDATE before deleting (LockSkillForDelete, LockPluginSkillsForDelete),
-- so either the delete waits for this attach to commit and its link cleanup
-- sees the new row, or this lock waits for the delete and finds no skill.
SELECT id FROM skill
WHERE id = ANY(sqlc.arg('skill_ids')::uuid[])
  AND workspace_id = sqlc.arg('workspace_id')
ORDER BY id
FOR SHARE;

-- name: LockProjectForSkillAttach :one
-- Taken in the attach transaction. DeleteProject locks the row FOR UPDATE
-- first (LockProjectForDelete), so a project deleted concurrently either waits
-- for the attach and removes its links, or the attach sees no project.
SELECT id FROM project
WHERE id = $1 AND workspace_id = $2
FOR SHARE;

-- name: AddProjectSkill :execrows
INSERT INTO project_skill (project_id, skill_id, workspace_id, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: RemoveProjectSkill :execrows
DELETE FROM project_skill
WHERE project_id = $1 AND skill_id = $2 AND workspace_id = $3;
