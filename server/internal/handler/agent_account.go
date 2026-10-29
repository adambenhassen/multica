package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// Accounts are workspace-level env sets an agent can opt into. Their env
// values follow the custom_env secret contract: never serialized on the
// account resource, written through the **** sentinel merge, and readable
// only through the audited env endpoint.
const (
	accountEnvActivityRevealed = "account_env_revealed"
	accountEnvActivityUpdated  = "account_env_updated"
	maxAccountNameLen          = 64
	maxAccountProviderLen      = 64
)

type AgentAccountResponse struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	EnvKeyCount int    `json:"env_key_count"`
	// EnvKeys lists key names for workspace owners/admins only, so the
	// editor can show which keys exist without ever loading values.
	EnvKeys []string `json:"env_keys"`
	// OverridesRuntimeDefault: agents on "Runtime default" of this provider
	// run with this account. At most one per provider.
	OverridesRuntimeDefault bool   `json:"overrides_runtime_default"`
	CreatedAt               string `json:"created_at"`
	UpdatedAt               string `json:"updated_at"`
}

type AccountEnvResponse struct {
	AccountID string            `json:"account_id"`
	Env       map[string]string `json:"env"`
}

type CreateAgentAccountRequest struct {
	Name                    string            `json:"name"`
	Provider                string            `json:"provider"`
	Env                     map[string]string `json:"env"`
	OverridesRuntimeDefault bool              `json:"overrides_runtime_default"`
}

type UpdateAgentAccountRequest struct {
	Name                    *string           `json:"name"`
	Provider                *string           `json:"provider"`
	Env                     map[string]string `json:"env"`
	OverridesRuntimeDefault *bool             `json:"overrides_runtime_default"`
}

type accountAgentRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func accountToResponse(a db.AgentAccount, includeKeys bool) AgentAccountResponse {
	keys := sortedKeys(unmarshalAccountEnv(a))
	resp := AgentAccountResponse{
		ID:                      uuidToString(a.ID),
		WorkspaceID:             uuidToString(a.WorkspaceID),
		Name:                    a.Name,
		Provider:                a.Provider,
		EnvKeyCount:             len(keys),
		EnvKeys:                 []string{},
		CreatedAt:               timestampToString(a.CreatedAt),
		OverridesRuntimeDefault: a.OverridesRuntimeDefault,
		UpdatedAt:               timestampToString(a.UpdatedAt),
	}
	if includeKeys {
		resp.EnvKeys = keys
	}
	return resp
}

// unmarshalAccountEnv mirrors unmarshalCustomEnv: never nil, never fails.
func unmarshalAccountEnv(a db.AgentAccount) map[string]string {
	out := map[string]string{}
	if len(a.Env) == 0 {
		return out
	}
	if err := json.Unmarshal(a.Env, &out); err != nil {
		slog.Warn("failed to unmarshal agent account env", "account_id", uuidToString(a.ID), "error", err)
		return map[string]string{}
	}
	if out == nil {
		return map[string]string{}
	}
	return out
}

func validateAccountName(raw string) (string, error) {
	for _, r := range raw {
		if unicode.IsControl(r) {
			return "", errors.New("name cannot contain tabs, newlines, or control characters")
		}
	}
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", errors.New("name is required")
	}
	if utf8.RuneCountInString(name) > maxAccountNameLen {
		return "", fmt.Errorf("name must be %d characters or fewer", maxAccountNameLen)
	}
	return name, nil
}

// validateAccountProvider accepts any runtime provider token. Qoder Cloud
// agents reject custom_env, so an account could never apply to one.
func validateAccountProvider(raw string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(raw))
	if provider == "" {
		return "", errors.New("provider is required")
	}
	if len(provider) > maxAccountProviderLen || strings.IndexFunc(provider, unicode.IsSpace) >= 0 {
		return "", errors.New("provider must be a runtime provider name such as claude or codex")
	}
	if provider == "qoder_cloud" {
		return "", errors.New("qoder_cloud agents do not accept env; accounts are not supported for this provider")
	}
	return provider, nil
}

func validateAccountEnvKeys(env map[string]string) error {
	for k := range env {
		if strings.TrimSpace(k) == "" || k != strings.TrimSpace(k) {
			return errors.New("env keys must be non-empty and have no surrounding whitespace")
		}
	}
	return nil
}

// authorizeAccountAdmin gates account writes and env reveals: human
// workspace owners/admins only. Agent actors are rejected even when the
// token behind them belongs to an admin, as in authorizeAgentEnv.
func (h *Handler) authorizeAccountAdmin(w http.ResponseWriter, r *http.Request) (db.Member, pgtype.UUID, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return db.Member{}, pgtype.UUID{}, false
	}
	if actorType, _ := h.resolveActor(r, requestUserID(r), workspaceID); actorType == "agent" {
		writeError(w, http.StatusForbidden, "agents may not manage accounts")
		return db.Member{}, pgtype.UUID{}, false
	}
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return db.Member{}, pgtype.UUID{}, false
	}
	return member, wsUUID, true
}

func (h *Handler) loadAccountInWorkspace(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID) (db.AgentAccount, bool) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "account id")
	if !ok {
		return db.AgentAccount{}, false
	}
	account, err := h.Queries.GetAgentAccountInWorkspace(r.Context(), db.GetAgentAccountInWorkspaceParams{ID: id, WorkspaceID: workspaceID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "account not found")
			return db.AgentAccount{}, false
		}
		slog.Warn("load agent account failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load account")
		return db.AgentAccount{}, false
	}
	return account, true
}

// writeAccountInUse rejects a change that would strand agents on an account
// they can no longer use, naming those agents.
func (h *Handler) writeAccountInUse(w http.ResponseWriter, r *http.Request, account db.AgentAccount, action string) bool {
	agents, err := h.Queries.ListAgentsUsingAccount(r.Context(), db.ListAgentsUsingAccountParams{
		WorkspaceID: account.WorkspaceID,
		AccountID:   account.ID,
	})
	if err != nil {
		slog.Warn("list agents using account failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to check account usage")
		return true
	}
	if len(agents) == 0 {
		return false
	}
	refs := make([]accountAgentRef, len(agents))
	names := make([]string, len(agents))
	for i, a := range agents {
		refs[i] = accountAgentRef{ID: uuidToString(a.ID), Name: a.Name}
		names[i] = a.Name
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":  fmt.Sprintf("cannot %s account %q: it is used by agents: %s", action, account.Name, strings.Join(names, ", ")),
		"agents": refs,
	})
	return true
}

func accountUniqueViolation(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName
	}
	return ""
}

func (h *Handler) ListAgentAccounts(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	actorType, _ := h.resolveActor(r, requestUserID(r), workspaceID)
	includeKeys := actorType != "agent" && roleAllowed(member.Role, "owner", "admin")

	accounts, err := h.Queries.ListAgentAccounts(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("list agent accounts failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list accounts")
		return
	}
	resp := make([]AgentAccountResponse, len(accounts))
	for i, a := range accounts {
		resp[i] = accountToResponse(a, includeKeys)
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": resp})
}

func (h *Handler) CreateAgentAccount(w http.ResponseWriter, r *http.Request) {
	member, wsUUID, ok := h.authorizeAccountAdmin(w, r)
	if !ok {
		return
	}
	var req CreateAgentAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name, err := validateAccountName(req.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	provider, err := validateAccountProvider(req.Provider)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateAccountEnvKeys(req.Env); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Merging against an empty map drops literal **** values, which are
	// never valid stored secrets.
	env, audit := mergeAgentEnv(map[string]string{}, req.Env)
	envBytes, err := json.Marshal(env)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode env")
		return
	}

	h.writeAccountEnvChange(w, r, member, func(qtx *db.Queries) (db.AgentAccount, error) {
		if req.OverridesRuntimeDefault {
			if err := moveRuntimeOverride(r.Context(), qtx, wsUUID, provider, pgtype.UUID{}); err != nil {
				return db.AgentAccount{}, err
			}
		}
		return qtx.CreateAgentAccount(r.Context(), db.CreateAgentAccountParams{
			WorkspaceID:             wsUUID,
			Name:                    name,
			Provider:                provider,
			Env:                     envBytes,
			CreatedBy:               member.UserID,
			OverridesRuntimeDefault: req.OverridesRuntimeDefault,
		})
	}, &audit, http.StatusCreated)
}

func (h *Handler) UpdateAgentAccount(w http.ResponseWriter, r *http.Request) {
	member, wsUUID, ok := h.authorizeAccountAdmin(w, r)
	if !ok {
		return
	}
	existing, ok := h.loadAccountInWorkspace(w, r, wsUUID)
	if !ok {
		return
	}
	var req UpdateAgentAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	params := db.UpdateAgentAccountParams{ID: existing.ID, WorkspaceID: wsUUID}
	if req.Name != nil {
		name, err := validateAccountName(*req.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		params.Name = pgtype.Text{String: name, Valid: true}
	}
	if req.Provider != nil {
		provider, err := validateAccountProvider(*req.Provider)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// Agents only use accounts of their runtime's provider.
		if provider != existing.Provider && h.writeAccountInUse(w, r, existing, "change the provider of") {
			return
		}
		params.Provider = pgtype.Text{String: provider, Valid: true}
	}
	var audit *envAudit
	if req.Env != nil {
		if err := validateAccountEnvKeys(req.Env); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		merged, envDiff := mergeAgentEnv(unmarshalAccountEnv(existing), req.Env)
		envBytes, err := json.Marshal(merged)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encode env")
			return
		}
		params.Env = envBytes
		audit = &envDiff
	}

	if req.OverridesRuntimeDefault != nil {
		params.OverridesRuntimeDefault = pgtype.Bool{Bool: *req.OverridesRuntimeDefault, Valid: true}
	}
	overrides := existing.OverridesRuntimeDefault
	if req.OverridesRuntimeDefault != nil {
		overrides = *req.OverridesRuntimeDefault
	}
	provider := existing.Provider
	if params.Provider.Valid {
		provider = params.Provider.String
	}

	h.writeAccountEnvChange(w, r, member, func(qtx *db.Queries) (db.AgentAccount, error) {
		if overrides {
			if err := moveRuntimeOverride(r.Context(), qtx, wsUUID, provider, existing.ID); err != nil {
				return db.AgentAccount{}, err
			}
		}
		return qtx.UpdateAgentAccount(r.Context(), params)
	}, audit, http.StatusOK)
}

// moveRuntimeOverride clears the override on the provider's other accounts
// before keepID (or a new account) takes it, inside the caller's transaction.
func moveRuntimeOverride(ctx context.Context, qtx *db.Queries, workspaceID pgtype.UUID, provider string, keepID pgtype.UUID) error {
	return qtx.ClearRuntimeOverrideAccounts(ctx, db.ClearRuntimeOverrideAccountsParams{
		WorkspaceID: workspaceID,
		Provider:    provider,
		KeepID:      keepID,
	})
}

// writeAccountEnvChange persists an account write and, when env changed,
// its key-only audit row in one transaction, so an env mutation is never
// stored without its audit trail.
func (h *Handler) writeAccountEnvChange(w http.ResponseWriter, r *http.Request, member db.Member, write func(*db.Queries) (db.AgentAccount, error), audit *envAudit, status int) {
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save account")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	account, err := write(qtx)
	if err != nil {
		switch accountUniqueViolation(err) {
		case "idx_agent_account_workspace_name":
			writeError(w, http.StatusConflict, "an account with this name already exists in this workspace")
			return
		case "idx_agent_account_runtime_override":
			writeError(w, http.StatusConflict, "another account of this provider took the runtime override at the same time; retry")
			return
		}
		slog.Warn("save agent account failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save account")
		return
	}
	if audit != nil {
		details, _ := json.Marshal(map[string]any{
			"account_id":     uuidToString(account.ID),
			"account_name":   account.Name,
			"added_keys":     audit.added,
			"removed_keys":   audit.removed,
			"changed_keys":   audit.changed,
			"preserved_keys": audit.preserved,
		})
		if _, err := qtx.CreateActivity(r.Context(), db.CreateActivityParams{
			ID:          dbid.NewV7(),
			WorkspaceID: account.WorkspaceID,
			ActorType:   pgtype.Text{String: "member", Valid: true},
			ActorID:     member.UserID,
			Action:      accountEnvActivityUpdated,
			Details:     details,
		}); err != nil {
			slog.Error("account_env_updated audit write failed; rolling back",
				append(logger.RequestAttrs(r), "error", err, "account_id", uuidToString(account.ID))...)
			writeError(w, http.StatusInternalServerError, "audit log write failed; account change rolled back")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save account")
		return
	}
	writeJSON(w, status, accountToResponse(account, true))
}

func (h *Handler) DeleteAgentAccount(w http.ResponseWriter, r *http.Request) {
	_, wsUUID, ok := h.authorizeAccountAdmin(w, r)
	if !ok {
		return
	}
	account, ok := h.loadAccountInWorkspace(w, r, wsUUID)
	if !ok {
		return
	}
	if h.writeAccountInUse(w, r, account, "delete") {
		return
	}
	if err := h.Queries.DeleteAgentAccount(r.Context(), db.DeleteAgentAccountParams{ID: account.ID, WorkspaceID: wsUUID}); err != nil {
		slog.Warn("delete agent account failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete account")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetAgentAccountEnv reveals an account's env values. Fail-closed audit, as
// in GetAgentEnv: no recorded reveal, no plaintext.
func (h *Handler) GetAgentAccountEnv(w http.ResponseWriter, r *http.Request) {
	member, wsUUID, ok := h.authorizeAccountAdmin(w, r)
	if !ok {
		return
	}
	account, ok := h.loadAccountInWorkspace(w, r, wsUUID)
	if !ok {
		return
	}
	env := unmarshalAccountEnv(account)
	keys := sortedKeys(env)
	details, _ := json.Marshal(map[string]any{
		"account_id":    uuidToString(account.ID),
		"account_name":  account.Name,
		"revealed_keys": keys,
		"key_count":     len(keys),
	})
	if _, err := h.Queries.CreateActivity(r.Context(), db.CreateActivityParams{
		ID:          dbid.NewV7(),
		WorkspaceID: account.WorkspaceID,
		ActorType:   pgtype.Text{String: "member", Valid: true},
		ActorID:     member.UserID,
		Action:      accountEnvActivityRevealed,
		Details:     details,
	}); err != nil {
		slog.Error("account_env_revealed audit write failed; refusing to serve plaintext",
			append(logger.RequestAttrs(r), "error", err, "account_id", uuidToString(account.ID))...)
		writeError(w, http.StatusInternalServerError, "audit log write failed; refusing to serve env without a recorded reveal")
		return
	}
	writeJSON(w, http.StatusOK, AccountEnvResponse{AccountID: uuidToString(account.ID), Env: env})
}

// effectiveAccount resolves the account a run uses on a runtime of provider:
// the run's own selection (a fallback run's entry, else the agent's account)
// when it exists and matches the provider, otherwise the provider's runtime
// override account, otherwise none (ok=false). fallbackPosition is 0 for a
// primary run.
func (h *Handler) effectiveAccount(ctx context.Context, agent db.Agent, fallbackPosition int32, provider string) (db.AgentAccount, bool, error) {
	selected := agent.AccountID
	if fallbackPosition > 0 {
		entry, err := h.Queries.GetAgentFallbackAtPosition(ctx, db.GetAgentFallbackAtPositionParams{
			AgentID:  agent.ID,
			Position: fallbackPosition,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return db.AgentAccount{}, false, err
		}
		selected = entry.AccountID
	}
	if selected.Valid {
		account, err := h.Queries.GetAgentAccountInWorkspace(ctx, db.GetAgentAccountInWorkspaceParams{
			ID:          selected,
			WorkspaceID: agent.WorkspaceID,
		})
		if err == nil && account.Provider == provider {
			return account, true, nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return db.AgentAccount{}, false, err
		}
	}
	account, err := h.Queries.GetRuntimeOverrideAccount(ctx, db.GetRuntimeOverrideAccountParams{
		WorkspaceID: agent.WorkspaceID,
		Provider:    provider,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.AgentAccount{}, false, nil
	}
	if err != nil {
		return db.AgentAccount{}, false, err
	}
	return account, true, nil
}

// accountEnvForTask returns the env the task's effective account contributes,
// nil when it has none.
func (h *Handler) accountEnvForTask(r *http.Request, agent db.Agent, task db.AgentTaskQueue, provider string) (map[string]string, error) {
	account, ok, err := h.effectiveAccount(r.Context(), agent, task.FallbackPosition.Int32, provider)
	if err != nil || !ok {
		return nil, err
	}
	return unmarshalAccountEnv(account), nil
}

// layerAccountEnv merges account env over custom_env: on a shared key the
// account wins. The daemon then layers the result over its process env and
// drops blocklisted keys, giving process env < custom_env < account env.
func layerAccountEnv(customEnv, accountEnv map[string]string) map[string]string {
	if len(accountEnv) == 0 {
		return customEnv
	}
	out := make(map[string]string, len(customEnv)+len(accountEnv))
	for k, v := range customEnv {
		out[k] = v
	}
	for k, v := range accountEnv {
		out[k] = v
	}
	return out
}

// overriddenEnvKeys returns the custom_env keys an account replaces.
func overriddenEnvKeys(customEnv, accountEnv map[string]string) []string {
	keys := []string{}
	for k := range customEnv {
		if _, ok := accountEnv[k]; ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// resolveAgentAccountUpdate decides whether an agent update writes
// account_id and to what (an invalid UUID clears it). An explicit account
// must belong to the workspace and match the provider the agent will run
// on; a runtime move to another provider clears the current account.
func (h *Handler) resolveAgentAccountUpdate(w http.ResponseWriter, r *http.Request, existing db.Agent, req UpdateAgentRequest, rawFields map[string]json.RawMessage, targetRuntimeID pgtype.UUID, targetProvider string) (bool, pgtype.UUID, bool) {
	_, touched := rawFields["account_id"]
	if !touched && (req.RuntimeID == nil || !existing.AccountID.Valid) {
		return false, pgtype.UUID{}, true
	}
	if touched && (req.AccountID == nil || *req.AccountID == "") {
		return true, pgtype.UUID{}, true
	}

	accountID := existing.AccountID
	if touched {
		var ok bool
		if accountID, ok = parseUUIDOrBadRequest(w, *req.AccountID, "account_id"); !ok {
			return false, pgtype.UUID{}, false
		}
	}
	account, err := h.Queries.GetAgentAccountInWorkspace(r.Context(), db.GetAgentAccountInWorkspaceParams{
		ID:          accountID,
		WorkspaceID: existing.WorkspaceID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to load account")
		return false, pgtype.UUID{}, false
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if touched {
			writeError(w, http.StatusBadRequest, "account not found")
			return false, pgtype.UUID{}, false
		}
		return true, pgtype.UUID{}, true
	}

	provider := targetProvider
	if provider == "" {
		var ok bool
		if provider, ok = h.resolveAgentProvider(r, existing.WorkspaceID, targetRuntimeID); !ok {
			if touched {
				writeError(w, http.StatusBadRequest, "cannot resolve agent runtime")
				return false, pgtype.UUID{}, false
			}
			return false, pgtype.UUID{}, true
		}
	}
	if account.Provider == provider {
		return touched, account.ID, true
	}
	if touched {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("account %q is for provider %q, but this agent runs on %q", account.Name, account.Provider, provider))
		return false, pgtype.UUID{}, false
	}
	return true, pgtype.UUID{}, true
}

// agentEnvAccountOverride is display-only, so a failed account lookup
// degrades to no hint instead of failing the env request.
func (h *Handler) agentEnvAccountOverride(r *http.Request, agent db.Agent, customEnv map[string]string) *AgentEnvAccountOverride {
	provider, ok := h.resolveAgentProvider(r, agent.WorkspaceID, agent.RuntimeID)
	if !ok {
		return nil
	}
	account, ok, err := h.effectiveAccount(r.Context(), agent, 0, provider)
	if err != nil {
		slog.Warn("load agent account for env override failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	if !ok {
		return nil
	}
	return &AgentEnvAccountOverride{
		AccountID:   uuidToString(account.ID),
		AccountName: account.Name,
		Keys:        overriddenEnvKeys(customEnv, unmarshalAccountEnv(account)),
	}
}
