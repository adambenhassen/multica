-- name: ListAgentAccounts :many
SELECT * FROM agent_account
WHERE workspace_id = $1
ORDER BY name;

-- name: GetAgentAccountInWorkspace :one
SELECT * FROM agent_account
WHERE id = $1 AND workspace_id = $2;

-- name: GetAgentAccountByNameInWorkspace :one
SELECT * FROM agent_account
WHERE name = $1 AND workspace_id = $2;

-- name: CreateAgentAccount :one
INSERT INTO agent_account (workspace_id, name, provider, env, created_by)
VALUES (@workspace_id, @name, @provider, @env, sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateAgentAccount :one
-- env is replaced wholesale; the handler applies the **** sentinel merge
-- before calling this, exactly as UpdateAgentCustomEnv does for custom_env.
UPDATE agent_account SET
    name = COALESCE(sqlc.narg('name'), name),
    provider = COALESCE(sqlc.narg('provider'), provider),
    env = COALESCE(sqlc.narg('env'), env),
    updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id
RETURNING *;

-- name: DeleteAgentAccount :exec
DELETE FROM agent_account
WHERE id = $1 AND workspace_id = $2;

-- name: ListAgentsUsingAccount :many
-- Archived agents count too: restoring one must not bring back a dangling
-- account_id.
SELECT id, name FROM agent
WHERE workspace_id = $1 AND account_id = $2
ORDER BY name;

-- name: SetAgentAccount :one
-- NULL clears the account so the agent runs with the runtime's own env.
UPDATE agent SET account_id = sqlc.narg('account_id'), updated_at = now()
WHERE id = @id
RETURNING *;
