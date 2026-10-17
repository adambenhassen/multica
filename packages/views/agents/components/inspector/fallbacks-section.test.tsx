// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
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
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// The real pickers need a runtime catalog; these doubles expose onChange.
vi.mock("./model-picker", () => ({
  ModelPicker: ({ value, canEdit, onChange }: { value: string; canEdit: boolean; onChange: (m: string) => void }) => (
    <button type="button" data-testid="model-picker" disabled={!canEdit} onClick={() => onChange("picked-model")}>
      {value || "no model"}
    </button>
  ),
}));
vi.mock("./thinking-prop-row", () => ({
  ThinkingSettingField: ({ value, canEdit, onChange }: { value: string; canEdit: boolean; onChange: (v: string) => void }) => (
    <button type="button" data-testid="effort-picker" disabled={!canEdit} onClick={() => onChange("high")}>
      {`effort ${value}`}
    </button>
  ),
}));
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

  it("disables every control for read-only users once the list has loaded", async () => {
    renderSection([CODEX, LOCAL], false);
    await screen.findByText("Fallback 1");
    expect(screen.getByRole("button", { name: "Add fallback" })).toBeDisabled();
    for (const name of ["Move down", "Remove fallback"]) {
      for (const button of screen.getAllByRole("button", { name })) expect(button).toBeDisabled();
    }
    for (const picker of screen.getAllByTestId("model-picker")) expect(picker).toBeDisabled();
  });

  it("shows a load error, keeps editing disabled, and retries", async () => {
    api.listAgentFallbacks.mockRejectedValue(new Error("boom"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <FallbacksSection agent={agent} runtimes={runtimes} members={[]} currentUserId="user-1" canEdit />
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText("Couldn't load fallbacks.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add fallback" })).toBeDisabled();

    api.listAgentFallbacks.mockResolvedValue([CODEX]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fallback 1")).toBeInTheDocument();
    expect(api.listAgentFallbacks).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't load fallbacks.")).not.toBeInTheDocument();
  });

  it("resets effort when a saved entry's model changes", async () => {
    renderSection([CODEX, LOCAL]);
    const [firstModel] = await screen.findAllByTestId("model-picker");
    fireEvent.click(firstModel!);
    await waitFor(() =>
      expect(api.replaceAgentFallbacks).toHaveBeenCalledWith("agent-1", {
        fallbacks: [
          { runtime_id: "rt-codex", model: "picked-model", thinking_level: "" },
          { runtime_id: "rt-local", model: "local-qwen", thinking_level: "" },
        ],
      }),
    );
  });

  it("saves a changed effort for that entry only", async () => {
    renderSection([CODEX, LOCAL]);
    const efforts = await screen.findAllByTestId("effort-picker");
    fireEvent.click(efforts[1]!);
    await waitFor(() =>
      expect(api.replaceAgentFallbacks).toHaveBeenCalledWith("agent-1", {
        fallbacks: [
          { runtime_id: "rt-codex", model: "gpt-5.6-terra", thinking_level: "xhigh" },
          { runtime_id: "rt-local", model: "local-qwen", thinking_level: "high" },
        ],
      }),
    );
  });

  it("keeps a new entry as a draft until a model is picked, then saves it", async () => {
    renderSection([CODEX]);
    await screen.findByText("Fallback 1");
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    expect(await screen.findByText("Fallback 2")).toBeInTheDocument();
    expect(api.replaceAgentFallbacks).not.toHaveBeenCalled();

    const pickers = screen.getAllByTestId("model-picker");
    fireEvent.click(pickers[pickers.length - 1]!);
    await waitFor(() =>
      expect(api.replaceAgentFallbacks).toHaveBeenCalledWith("agent-1", {
        fallbacks: [
          { runtime_id: "rt-codex", model: "gpt-5.6-terra", thinking_level: "xhigh" },
          { runtime_id: "rt-claude", model: "picked-model", thinking_level: "" },
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
  });

  it("toasts a failed save and keeps the draft", async () => {
    renderSection([CODEX]);
    await screen.findByText("Fallback 1");
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    api.replaceAgentFallbacks.mockRejectedValue(new Error("runtime is offline"));
    const pickers = await screen.findAllByTestId("model-picker");
    fireEvent.click(pickers[pickers.length - 1]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save fallbacks", { description: "runtime is offline" }),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("disables every control while a save is in flight", async () => {
    renderSection([CODEX, LOCAL]);
    await screen.findByText("Fallback 1");
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    await screen.findByText("Fallback 3");
    let settle!: () => void;
    api.replaceAgentFallbacks.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));

    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add fallback" })).toBeDisabled());
    for (const name of ["Move up", "Move down", "Remove fallback"]) {
      for (const button of screen.getAllByRole("button", { name })) expect(button).toBeDisabled();
    }
    // 2 saved + 1 draft model pickers, 2 saved effort pickers.
    expect(screen.getAllByTestId("model-picker")).toHaveLength(3);
    for (const picker of [...screen.getAllByTestId("model-picker"), ...screen.getAllByTestId("effort-picker")]) {
      expect(picker).toBeDisabled();
    }
    expect(api.replaceAgentFallbacks).toHaveBeenCalledTimes(1);

    settle();
    await waitFor(() => expect(screen.getAllByTestId("effort-picker")[0]).toBeEnabled());
  });
});
