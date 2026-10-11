-- Project-Skill junction

-- name: ListProjectSkillsInWorkspace :many
-- Full skill rows for the daemon claim path. Both sides are workspace-scoped,
-- so a corrupt project reference cannot lift another tenant's skill into a run.
SELECT s.* FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = $1
  AND ps.workspace_id = $2
  AND s.workspace_id = $2
ORDER BY s.name ASC;

-- name: ListProjectSkillsByIDs :many
-- Scoped variant of ListProjectSkillsInWorkspace for the skill-bundle resolve
-- path. The junction predicate is the authorization: a skill not attached to
-- the project returns no row, which the caller reports as not-found.
SELECT s.* FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = $1
  AND ps.workspace_id = $2
  AND s.workspace_id = $2
  AND s.id = ANY(sqlc.arg('skill_ids')::uuid[])
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

-- name: AddProjectSkill :exec
INSERT INTO project_skill (project_id, skill_id, workspace_id, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: RemoveProjectSkill :execrows
DELETE FROM project_skill
WHERE project_id = $1 AND skill_id = $2 AND workspace_id = $3;
