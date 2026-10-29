// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAccount } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

const ACCOUNT: AgentAccount = {
  id: "account-1",
  workspace_id: "workspace-1",
  name: "Claude A",
  provider: "claude",
  env_key_count: 1,
  env_keys: ["CLAUDE_CODE_OAUTH_TOKEN"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  role: "owner",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey[0] === "accounts"
      ? { data: [ACCOUNT], isLoading: false }
      : { data: [{ provider: "claude" }, { provider: "codex" }], isLoading: false },
}));
vi.mock("@multica/core/agents", () => ({
  agentAccountListOptions: () => ({ queryKey: ["accounts"] }),
  useCreateAgentAccount: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateAgentAccount: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteAgentAccount: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));
vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
  providerDisplayName: (provider: string) => provider,
}));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "workspace-1", name: "Acme" }),
}));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: mocks.role, isLoading: false }),
}));
vi.mock("./settings-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings-layout")>()),
  SettingsReadOnlyNotice: () => <div role="note">read only</div>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentAccountsTab } from "./agent-accounts-tab";

describe("AgentAccountsTab", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.role = "owner";
  });

  it("keeps untouched stored values and sends only retyped ones", async () => {
    const user = userEvent.setup();
    mocks.update.mockResolvedValue(ACCOUNT);
    renderWithI18n(<AgentAccountsTab />);

    await user.click(screen.getByRole("button", { name: "Edit Claude A" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    const keys = screen.getAllByRole("textbox", { name: "Variable name" });
    await user.type(keys[1]!, "ANTHROPIC_BASE_URL");
    await user.type(
      screen.getByLabelText("Value for ANTHROPIC_BASE_URL"),
      "https://example.test",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.update).toHaveBeenCalledWith({
      id: "account-1",
      name: "Claude A",
      provider: "claude",
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "****",
        ANTHROPIC_BASE_URL: "https://example.test",
      },
    });
  });

  it("surfaces the server's in-use rejection on delete", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    mocks.remove.mockRejectedValue(
      new Error("account is in use by agents: Builder, Reviewer"),
    );
    renderWithI18n(<AgentAccountsTab />);

    await user.click(screen.getByRole("button", { name: "Delete Claude A" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(mocks.remove).toHaveBeenCalledWith("account-1");
    expect(toast.error).toHaveBeenCalledWith(
      "account is in use by agents: Builder, Reviewer",
    );
  });

  it("hides write actions from members", () => {
    mocks.role = "member";
    renderWithI18n(<AgentAccountsTab />);

    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Claude A" })).toBeNull();
  });
});
