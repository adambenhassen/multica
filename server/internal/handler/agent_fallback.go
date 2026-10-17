package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// taskRuntimeBound reports whether a claimed run may execute on its runtime:
// a primary run is bound only by the agent's own runtime; a fallback run only
// by the agent's fallback entry at the run's position, matching runtime and
// model. Reordering, editing or removing entries makes runs queued under the
// old list fail delivery.
func taskRuntimeBound(ctx context.Context, q *db.Queries, agent db.Agent, task db.AgentTaskQueue) (bool, error) {
	if task.FallbackPosition.Valid {
		return q.AgentFallbackBindsRuntime(ctx, db.AgentFallbackBindsRuntimeParams{
			AgentID:   agent.ID,
			Position:  task.FallbackPosition.Int32,
			RuntimeID: task.RuntimeID,
			Model:     task.Model.String,
		})
	}
	return agent.RuntimeID == task.RuntimeID, nil
}

const maxAgentFallbacks = 4

// AgentFallbackResponse is one ordered fallback (runtime, model) of an agent.
type AgentFallbackResponse struct {
	Position      int32  `json:"position"`
	RuntimeID     string `json:"runtime_id"`
	Model         string `json:"model"`
	ThinkingLevel string `json:"thinking_level"`
}

type replaceAgentFallbacksRequest struct {
	Fallbacks []struct {
		RuntimeID     string `json:"runtime_id"`
		Model         string `json:"model"`
		ThinkingLevel string `json:"thinking_level"`
	} `json:"fallbacks"`
}

func agentFallbacksToResponse(rows []db.AgentModelFallback) []AgentFallbackResponse {
	out := make([]AgentFallbackResponse, len(rows))
	for i, row := range rows {
		out[i] = AgentFallbackResponse{
			Position:      row.Position,
			RuntimeID:     uuidToString(row.RuntimeID),
			Model:         row.Model,
			ThinkingLevel: row.ThinkingLevel.String,
		}
	}
	return out
}

// ListAgentFallbacks returns the agent's ordered fallback list. Same access
// gate as the agent's run history.
func (h *Handler) ListAgentFallbacks(w http.ResponseWriter, r *http.Request) {
	target, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	workspaceID := uuidToString(target.WorkspaceID)
	actorType, actorID := h.resolveActor(r, requestUserID(r), workspaceID)
	if !h.canAccessPrivateAgent(r.Context(), target, actorType, actorID, workspaceID) {
		writeError(w, http.StatusForbidden, "you do not have access to this agent")
		return
	}
	rows, err := h.Queries.ListAgentFallbacks(r.Context(), target.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent fallbacks")
		return
	}
	writeJSON(w, http.StatusOK, agentFallbacksToResponse(rows))
}

// ReplaceAgentFallbacks replaces the agent's whole fallback list in one
// transaction, cancelling queued fallback runs whose entry it changed. Agent
// owner or workspace owner/admin only; agents are refused.
func (h *Handler) ReplaceAgentFallbacks(w http.ResponseWriter, r *http.Request) {
	target, ok := h.loadAgentForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	workspaceID := uuidToString(target.WorkspaceID)
	if actorType, _ := h.resolveActor(r, requestUserID(r), workspaceID); actorType == "agent" {
		writeError(w, http.StatusForbidden, "agents cannot change fallbacks")
		return
	}
	if !h.canManageAgent(w, r, target) {
		return
	}
	var req replaceAgentFallbacksRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Fallbacks == nil {
		writeError(w, http.StatusBadRequest, "fallbacks is required; send [] to clear the list")
		return
	}
	if len(req.Fallbacks) > maxAgentFallbacks {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("an agent can have at most %d fallbacks", maxAgentFallbacks))
		return
	}
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	type pair struct {
		runtime pgtype.UUID
		model   string
	}
	seen := map[pair]bool{{target.RuntimeID, strings.TrimSpace(target.Model.String)}: true}
	inserts := make([]db.InsertAgentFallbackParams, 0, len(req.Fallbacks))
	for i, f := range req.Fallbacks {
		n := i + 1
		runtimeUUID, ok := parseUUIDOrBadRequest(w, f.RuntimeID, "runtime_id")
		if !ok {
			return
		}
		model := strings.TrimSpace(f.Model)
		if model == "" {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("fallback %d: model is required", n))
			return
		}
		rt, err := h.Queries.GetAgentRuntimeForWorkspace(r.Context(), db.GetAgentRuntimeForWorkspaceParams{
			ID: runtimeUUID, WorkspaceID: target.WorkspaceID,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("fallback %d: invalid runtime_id", n))
			return
		}
		// Same gate as binding the agent itself, plus the claim-time rule that a
		// private runtime only runs its owner's agents.
		if !rt.OwnerID.Valid {
			writeError(w, http.StatusForbidden, fmt.Sprintf("fallback %d: this runtime has no owner and cannot run agents", n))
			return
		}
		if !canUseRuntimeForAgent(member, rt) || (rt.Visibility == "private" && rt.OwnerID != target.OwnerID) {
			writeError(w, http.StatusForbidden, fmt.Sprintf("fallback %d: this runtime is private; only its owner's agents can use it", n))
			return
		}
		key := pair{rt.ID, model}
		if seen[key] {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("fallback %d duplicates the agent's runtime and model or another fallback", n))
			return
		}
		seen[key] = true
		level := strings.TrimSpace(f.ThinkingLevel)
		if level != "" {
			if msg, ok := h.fallbackThinkingRejection(r.Context(), rt, level); !ok {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("fallback %d: %s", n, msg))
				return
			}
		}
		inserts = append(inserts, db.InsertAgentFallbackParams{
			WorkspaceID:   target.WorkspaceID,
			AgentID:       target.ID,
			Position:      int32(n),
			RuntimeID:     rt.ID,
			Model:         model,
			ThinkingLevel: pgtype.Text{String: level, Valid: level != ""},
		})
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	// Serialize concurrent replaces of the same list.
	locked, err := qtx.GetAgentForUpdate(r.Context(), target.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
		return
	}
	// The list was validated against the pre-lock agent; refuse if it moved.
	if locked.OwnerID != target.OwnerID || locked.RuntimeID != target.RuntimeID || locked.Model != target.Model {
		writeError(w, http.StatusConflict, "agent changed while saving fallbacks; retry")
		return
	}
	if err := qtx.DeleteAgentFallbacks(r.Context(), target.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
		return
	}
	rows := make([]db.AgentModelFallback, 0, len(inserts))
	for _, p := range inserts {
		row, err := qtx.InsertAgentFallback(r.Context(), p)
		if err != nil {
			slog.Warn("replace agent fallbacks: insert failed", append(logger.RequestAttrs(r), "agent_id", uuidToString(target.ID), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
			return
		}
		rows = append(rows, row)
	}
	cancelled, err := qtx.CancelUnboundQueuedFallbackTasks(r.Context(), target.ID)
	if err == nil {
		err = service.SettleTerminalTaskState(r.Context(), qtx, cancelled...)
	}
	if err != nil {
		slog.Warn("replace agent fallbacks: cancel unbound fallback runs failed", append(logger.RequestAttrs(r), "agent_id", uuidToString(target.ID), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save agent fallbacks")
		return
	}
	if len(cancelled) > 0 {
		h.TaskService.BroadcastCancelledTasks(r.Context(), workspaceID, cancelled)
	}
	writeJSON(w, http.StatusOK, agentFallbacksToResponse(rows))
}

// fallbackThinkingRejection applies the agent-update effort checks to one
// fallback runtime. Returns the rejection message and false when invalid.
func (h *Handler) fallbackThinkingRejection(ctx context.Context, rt db.AgentRuntime, level string) (string, bool) {
	if !agent.IsKnownThinkingValue(rt.Provider, level) {
		return thinkingLevelRejection(rt.Provider, level), false
	}
	switch h.acpThinkingDecision(ctx, rt.Provider, rt.ID) {
	case acpEffortAbsent:
		return thinkingCapabilityRejection(rt.Provider), false
	case acpEffortUnknown:
		return thinkingCapabilityUnknownRejection(rt.Provider), false
	}
	return "", true
}
