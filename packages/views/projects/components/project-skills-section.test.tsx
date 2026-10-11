// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";

const addMock = vi.fn().mockResolvedValue(undefined);
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

const ATTACHED = skill("skill-1", "deploy-checklist");
const AVAILABLE = skill("skill-2", "review-helper");

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-skills") return { data: [ATTACHED] };
    if (key === "workspace-skills") return { data: [ATTACHED, AVAILABLE], isLoading: false };
    return { data: [] };
  },
}));

vi.mock("@multica/core/projects", () => ({
  projectSkillsOptions: () => ({ queryKey: ["project-skills"], queryFn: vi.fn() }),
  useAddProjectSkills: () => ({ mutateAsync: addMock, isPending: false }),
  useRemoveProjectSkill: () => ({ mutateAsync: removeMock, isPending: false }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  skillListOptions: () => ({ queryKey: ["workspace-skills"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectSkillsSection } from "./project-skills-section";

describe("ProjectSkillsSection", () => {
  beforeEach(() => {
    addMock.mockClear();
    removeMock.mockClear();
  });

  it("lists attached skills and removes one", async () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" />);
    expect(screen.getByText("deploy-checklist")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove deploy-checklist" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("skill-1"));
  });

  it("offers only unattached skills and adds the selection", async () => {
    renderWithI18n(<ProjectSkillsSection projectId="p1" />);

    fireEvent.click(screen.getByRole("button", { name: /add skill/i }));
    expect(screen.queryByRole("button", { name: /deploy-checklist/ , pressed: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /review-helper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 skill" }));

    await waitFor(() => expect(addMock).toHaveBeenCalledWith(["skill-2"]));
  });
});
