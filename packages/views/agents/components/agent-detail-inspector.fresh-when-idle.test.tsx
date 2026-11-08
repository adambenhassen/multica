import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { Agent } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { AgentDetailInspector } from "./agent-detail-inspector";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isSuccess: false }),
}));
vi.mock("../../common/avatar-upload-control", () => ({
  AvatarUploadControl: () => <div data-testid="avatar-upload" />,
}));
vi.mock("./inspector/fallbacks-section", () => ({
  FallbacksSection: () => <div data-testid="fallbacks-section" />,
}));
vi.mock("./inspector/model-picker", () => ({
  ModelPicker: () => <div data-testid="model-picker" />,
}));
vi.mock("./inspector/runtime-picker", () => ({
  RuntimePicker: () => <div data-testid="runtime-picker" />,
}));
vi.mock("./inspector/thinking-prop-row", () => ({
  ThinkingSettingField: () => <div data-testid="thinking-field" />,
}));
vi.mock("./inspector/service-tier-setting-field", () => ({
  ServiceTierSettingField: () => <div data-testid="service-tier-field" />,
}));

const baseAgent = {
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Lambda",
  description: "Test agent",
  runtime_id: "runtime-1",
  max_concurrent_tasks: 1,
} as Agent;

const LABEL = "New session after 50 minutes";

function renderInspector(agent: Agent, canEdit = true) {
  const onUpdate = vi.fn(async () => {});
  renderWithI18n(
    <AgentDetailInspector
      agent={agent}
      runtime={null}
      runtimes={[]}
      members={[]}
      currentUserId="user-1"
      canEdit={canEdit}
      onUpdate={onUpdate}
    />,
  );
  return { onUpdate, toggle: () => screen.getByRole("switch", { name: LABEL }) };
}

describe("AgentDetailInspector fresh session toggle", () => {
  afterEach(() => cleanup());

  it("is off when an older server omits the field, and saves on", () => {
    const { onUpdate, toggle } = renderInspector(baseAgent);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle());
    expect(onUpdate).toHaveBeenCalledWith("agent-1", { fresh_session_when_idle: true });
  });

  it("reflects the saved value and saves off", () => {
    const { onUpdate, toggle } = renderInspector({ ...baseAgent, fresh_session_when_idle: true });
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle());
    expect(onUpdate).toHaveBeenCalledWith("agent-1", { fresh_session_when_idle: false });
  });

  it("cannot be changed without edit access", () => {
    const { onUpdate, toggle } = renderInspector(baseAgent, false);
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
