// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAccount } from "@multica/core/types";
import { renderWithI18n } from "../../../test/i18n";
import { AccountPicker } from "./account-picker";

function account(id: string, name: string, provider: string): AgentAccount {
  return {
    id,
    workspace_id: "ws-1",
    name,
    provider,
    env_key_count: 1,
    env_keys: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const ACCOUNTS = [
  account("acc-claude-a", "Claude A", "claude"),
  account("acc-claude-b", "Claude B", "claude"),
  account("acc-codex", "Codex Team", "codex"),
];

describe("AccountPicker", () => {
  afterEach(cleanup);

  it("lists only accounts for the runtime's provider plus Runtime default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <AccountPicker
        accounts={ACCOUNTS}
        provider="claude"
        value="acc-claude-a"
        canEdit
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Claude A/ }));

    expect(screen.getByText("Claude B")).toBeInTheDocument();
    expect(screen.queryByText("Codex Team")).toBeNull();

    await user.click(screen.getByText("Runtime default"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("selects an account by id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithI18n(
      <AccountPicker
        accounts={ACCOUNTS}
        provider="codex"
        value={null}
        canEdit
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Runtime default/ }));
    expect(screen.queryByText("Claude A")).toBeNull();

    await user.click(screen.getByText("Codex Team"));
    expect(onChange).toHaveBeenCalledWith("acc-codex");
  });

  it("renders read-only without a trigger when the viewer cannot edit", () => {
    renderWithI18n(
      <AccountPicker
        accounts={ACCOUNTS}
        provider="claude"
        value="acc-claude-b"
        canEdit={false}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Claude B")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
