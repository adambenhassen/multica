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
INSERT INTO agent_account (workspace_id, name, provider, env, created_by, overrides_runtime_default)
VALUES (@workspace_id, @name, @provider, @env, sqlc.narg('created_by'), @overrides_runtime_default)
RETURNING *;

-- name: UpdateAgentAccount :one
-- env is replaced wholesale; the handler applies the **** sentinel merge
-- before calling this, exactly as UpdateAgentCustomEnv does for custom_env.
UPDATE agent_account SET
    name = COALESCE(sqlc.narg('name'), name),
    provider = COALESCE(sqlc.narg('provider'), provider),
    env = COALESCE(sqlc.narg('env'), env),
    overrides_runtime_default = COALESCE(sqlc.narg('overrides_runtime_default'), overrides_runtime_default),
    updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id
RETURNING *;

-- name: DeleteAgentAccount :exec
DELETE FROM agent_account
WHERE id = $1 AND workspace_id = $2;

-- name: ListAgentsUsingAccount :many
-- Archived agents count too: restoring one must not bring back a dangling
-- account_id. Fallback entries that name the account count as use.
SELECT a.id, a.name FROM agent a
WHERE a.workspace_id = @workspace_id
  AND (a.account_id = @account_id
       OR a.id IN (SELECT f.agent_id FROM agent_model_fallback f WHERE f.account_id = @account_id))
ORDER BY a.name;

-- name: SetAgentAccount :one
-- NULL clears the account so the agent runs with the runtime's own env.
UPDATE agent SET account_id = sqlc.narg('account_id'), updated_at = now()
WHERE id = @id
RETURNING *;

-- name: GetRuntimeOverrideAccount :one
-- The account that replaces a provider's runtime default in a workspace.
SELECT * FROM agent_account
WHERE workspace_id = $1 AND provider = $2 AND overrides_runtime_default;

-- name: ClearRuntimeOverrideAccounts :exec
-- Turns the override off on every other account of the provider, so setting
-- it on one account moves it there.
UPDATE agent_account SET overrides_runtime_default = false, updated_at = now()
WHERE workspace_id = @workspace_id AND provider = @provider
  AND overrides_runtime_default AND id IS DISTINCT FROM sqlc.narg('keep_id');
