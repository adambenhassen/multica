// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Agent, AgentModelFallback, AgentRuntime } from "@multica/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import enAgents from "../../../locales/en/agents.json";
import enCommon from "../../../locales/en/common.json";
import enIssues from "../../../locales/en/issues.json";
import enSettings from "../../../locales/en/settings.json";
import { FallbacksSection } from "./fallbacks-section";

const TEST_RESOURCES = {
  en: { common: enCommon, agents: enAgents, issues: enIssues, settings: enSettings },
};

const api = vi.hoisted(() => ({
  listAgentFallbacks: vi.fn(),
  replaceAgentFallbacks: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({ api }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/runtimes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/runtimes")>()),
  runtimeModelsOptions: (runtimeId: string | null) => ({
    enabled: Boolean(runtimeId),
    queryKey: ["runtime-models", runtimeId],
    queryFn: async () => ({ models: [], unavailableModels: [], supported: true }),
  }),
}));

const CODEX: AgentModelFallback = { position: 1, runtime_id: "rt-codex", model: "gpt-5.6-terra", thinking_level: "xhigh" };
const LOCAL: AgentModelFallback = { position: 2, runtime_id: "rt-local", model: "local-qwen", thinking_level: "" };
const agent = { id: "agent-1", runtime_id: "rt-claude" } as unknown as Agent;
const runtimes = [
  { id: "rt-claude", name: "Claude", provider: "claude", status: "online" },
  { id: "rt-codex", name: "Codex", provider: "codex", status: "online" },
  { id: "rt-local", name: "Local", provider: "opencode", status: "online" },
] as unknown as AgentRuntime[];

function renderSection(saved: AgentModelFallback[], canEdit = true) {
  api.listAgentFallbacks.mockResolvedValue(saved);
  api.replaceAgentFallbacks.mockResolvedValue([]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <FallbacksSection agent={agent} runtimes={runtimes} members={[]} currentUserId="user-1" canEdit={canEdit} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FallbacksSection", () => {
  it("lists saved fallbacks in order", async () => {
    renderSection([CODEX, LOCAL]);
    expect(await screen.findByText("Fallback 1")).toBeInTheDocument();
    expect(screen.getByText("Fallback 2")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-terra")).toBeInTheDocument();
    expect(screen.getByText("local-qwen")).toBeInTheDocument();
  });

  it("moves an entry down and saves the reordered list", async () => {
    renderSection([CODEX, LOCAL]);
    const [firstMoveDown] = await screen.findAllByRole("button", { name: "Move down" });
    fireEvent.click(firstMoveDown!);
    await waitFor(() =>
      expect(api.replaceAgentFallbacks).toHaveBeenCalledWith("agent-1", {
        fallbacks: [
          { runtime_id: "rt-local", model: "local-qwen", thinking_level: "" },
          { runtime_id: "rt-codex", model: "gpt-5.6-terra", thinking_level: "xhigh" },
        ],
      }),
    );
  });

  it("removes an entry", async () => {
    renderSection([CODEX, LOCAL]);
    const [firstRemove] = await screen.findAllByRole("button", { name: "Remove fallback" });
    fireEvent.click(firstRemove!);
    await waitFor(() =>
      expect(api.replaceAgentFallbacks).toHaveBeenCalledWith("agent-1", {
        fallbacks: [{ runtime_id: "rt-local", model: "local-qwen", thinking_level: "" }],
      }),
    );
  });

  it("disables Add fallback at four entries", async () => {
    renderSection([
      CODEX,
      LOCAL,
      { ...CODEX, position: 3, model: "gpt-5.6-mini" },
      { ...LOCAL, position: 4, model: "local-llama" },
    ]);
    await screen.findByText("Fallback 4");
    expect(screen.getByRole("button", { name: "Add fallback" })).toBeDisabled();
  });

  it("disables Add fallback for read-only users", async () => {
    renderSection([], false);
    expect(await screen.findByRole("button", { name: "Add fallback" })).toBeDisabled();
  });

  it("blocks editing until the saved list has loaded", async () => {
    api.listAgentFallbacks.mockRejectedValue(new Error("boom"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <FallbacksSection agent={agent} runtimes={runtimes} members={[]} currentUserId="user-1" canEdit />
        </QueryClientProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(api.listAgentFallbacks).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Add fallback" })).toBeDisabled();
  });
});
