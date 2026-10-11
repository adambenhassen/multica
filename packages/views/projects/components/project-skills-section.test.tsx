// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";

const addMock = vi.fn().mockResolvedValue(undefined);
const audienceMock = vi.fn().mockResolvedValue(undefined);
const removeMock = vi.fn().mockResolvedValue(undefined);

function skill(id: string, name: string) {
  return {
    id,
    workspace_id: "workspace-1",
    name,
    description: "",
    config: {},
    created_by: null,
    created_at: "",
    updated_at: "",
    labels: [],
  };
}

const ATTACHED = {
  ...skill("skill-1", "deploy-checklist"),
  audience: { restricted: true, agent_ids: ["agent-ops"], label_ids: ["label-ops"] },
};
const AVAILABLE = skill("skill-2", "review-helper");

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-skills") return { data: [ATTACHED] };
    if (key === "workspace-skills") return { data: [ATTACHED, AVAILABLE], isLoading: false };
    if (key === "agents") return { data: [{ id: "agent-ops", name: "DevOps", archived_at: null }, { id: "agent-qa", name: "QA", archived_at: null }] };
    if (key === "agent-labels") return { data: [{ id: "label-ops", name: "ops" }] };
    return { data: [] };
  },
}));

vi.mock("@multica/core/projects", () => ({
  projectSkillsOptions: () => ({ queryKey: ["project-skills"], queryFn: vi.fn() }),
  useAddProjectSkills: () => ({ mutateAsync: addMock, isPending: false }),
  useRemoveProjectSkill: () => ({ mutateAsync: removeMock, isPending: false, variables: undefined }),
  useSetProjectSkillAudience: () => ({ mutateAsync: audienceMock, isPending: false }),
}));
vi.mock("@multica/core/labels", () => ({
  labelListOptions: () => ({ queryKey: ["agent-labels"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  skillListOptions: () => ({ queryKey: ["workspace-skills"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectSkillsSection } from "./project-skills-section";

describe("ProjectSkillsSection", () => {
  beforeEach(() => {
    addMock.mockClear();
    removeMock.mockClear();
    audienceMock.mockClear();
  });

  it("shows who a restricted skill reaches and saves a new audience", async () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" canManage />);
    const chip = screen.getByRole("button", { name: /Change who gets deploy-checklist \(now: DevOps, #ops\)/ });
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("checkbox", { name: "QA" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(audienceMock).toHaveBeenCalledWith({
        skillId: "skill-1",
        audience: { restricted: true, agent_ids: ["agent-ops", "agent-qa"], label_ids: ["label-ops"] },
      }),
    );
  });

  it("shows the audience read-only to members who cannot manage it", () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" canManage={false} />);
    expect(screen.getByText("DevOps, #ops")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Change who gets/ })).toBeNull();
  });

  it("lists attached skills and removes one", async () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" canManage />);
    expect(screen.getByText("deploy-checklist")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove deploy-checklist" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("skill-1"));
  });

  it("offers only unattached skills and adds the selection", async () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" canManage />);

    fireEvent.click(screen.getByRole("button", { name: /add skill/i }));
    expect(screen.queryByRole("button", { name: /deploy-checklist/ , pressed: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /review-helper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 skill" }));

    await waitFor(() => expect(addMock).toHaveBeenCalledWith(["skill-2"]));
  });

  it("hides attach and detach controls from members who cannot manage them", () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" canManage={false} />);
    expect(screen.getByText("deploy-checklist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add skill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove deploy-checklist" })).toBeNull();
  });
});
