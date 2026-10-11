-- Project-Skill junction

-- name: ListProjectSkillsForAgent :many
-- Full skill rows for the daemon claim path. Both sides are workspace-scoped,
-- so a corrupt project reference cannot lift another tenant's skill into a run.
-- A skill the agent has attached but disabled stays off: the agent owner's
-- opt-out wins over the project attachment.
-- A restricted link reaches only its audience (agents, or agents carrying a
-- listed label); unrestricted links reach every agent in the project.
SELECT s.* FROM skill s
JOIN project_skill ps ON ps.skill_id = s.id
WHERE ps.project_id = sqlc.arg('project_id')
  AND ps.workspace_id = sqlc.arg('workspace_id')
  AND s.workspace_id = sqlc.arg('workspace_id')
  AND (ps.restricted = FALSE
    OR EXISTS (
      SELECT 1 FROM project_attachment_audience paa
      WHERE paa.project_id = ps.project_id
        AND paa.workspace_id = ps.workspace_id
        AND paa.item_type = 'skill'
        AND paa.item_id = s.id
        AND ((paa.target_type = 'agent' AND paa.target_id = sqlc.arg('agent_id'))
          OR (paa.target_type = 'label' AND paa.target_id IN (
                SELECT atl.label_id FROM agent_to_label atl WHERE atl.agent_id = sqlc.arg('agent_id'))))
    ))
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
  AND (ps.restricted = FALSE
    OR EXISTS (
      SELECT 1 FROM project_attachment_audience paa
      WHERE paa.project_id = ps.project_id
        AND paa.workspace_id = ps.workspace_id
        AND paa.item_type = 'skill'
        AND paa.item_id = s.id
        AND ((paa.target_type = 'agent' AND paa.target_id = sqlc.arg('agent_id'))
          OR (paa.target_type = 'label' AND paa.target_id IN (
                SELECT atl.label_id FROM agent_to_label atl WHERE atl.agent_id = sqlc.arg('agent_id'))))
    ))
  AND NOT EXISTS (
    SELECT 1 FROM agent_skill ask
    WHERE ask.agent_id = sqlc.arg('agent_id')
      AND ask.skill_id = s.id
      AND ask.enabled = FALSE
  )
ORDER BY s.name ASC;

-- name: ListProjectSkillSummaries :many
-- Summary variant for the project skills list endpoint — omits `content`.
SELECT s.id, s.workspace_id, s.name, s.description, s.config, s.created_by, s.created_at, s.updated_at, ps.restricted
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

-- name: LockProjectForAttach :one
-- Taken in project skill and MCP server attach transactions. DeleteProject
-- locks the row FOR UPDATE first (LockProjectForDelete), so a project deleted
-- concurrently either waits for the attach and removes its links, or the
-- attach sees no project. KEY SHARE is enough to conflict with that and does
-- not block ordinary project edits (title, status, lead) during an attach.
SELECT id FROM project
WHERE id = $1 AND workspace_id = $2
FOR KEY SHARE;

-- name: AddProjectSkill :execrows
INSERT INTO project_skill (project_id, skill_id, workspace_id, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: SetProjectSkillRestricted :execrows
UPDATE project_skill SET restricted = sqlc.arg('restricted')
WHERE project_id = sqlc.arg('project_id') AND skill_id = sqlc.arg('skill_id') AND workspace_id = sqlc.arg('workspace_id');

-- name: RemoveProjectSkill :execrows
-- The link's audience has no FK, so it goes in the same statement.
WITH deleted_audience AS (
    DELETE FROM project_attachment_audience
    WHERE project_attachment_audience.project_id = $1
      AND project_attachment_audience.item_type = 'skill'
      AND project_attachment_audience.item_id = $2
      AND project_attachment_audience.workspace_id = $3
)
DELETE FROM project_skill
WHERE project_skill.project_id = $1 AND project_skill.skill_id = $2 AND project_skill.workspace_id = $3;
