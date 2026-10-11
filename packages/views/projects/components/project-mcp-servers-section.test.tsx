// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";

const addMock = vi.fn().mockResolvedValue(undefined);
const removeMock = vi.fn().mockResolvedValue(undefined);

function server(id: string, name: string, transport: string) {
  return { id, workspace_id: "workspace-1", name, transport, created_at: "", updated_at: "" };
}

const ATTACHED = server("srv-1", "linear", "http");
const AVAILABLE = server("srv-2", "postgres", "stdio");
let library = [ATTACHED, AVAILABLE];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-mcp") return { data: [ATTACHED] };
    if (key === "workspace-mcp") return { data: library };
    if (key === "agents") return { data: [] };
    if (key === "agent-labels") return { data: [] };
    return { data: [] };
  },
}));

vi.mock("@multica/core/projects", () => ({
  projectMcpServersOptions: () => ({ queryKey: ["project-mcp"], queryFn: vi.fn() }),
  useAddProjectMcpServers: () => ({ mutateAsync: addMock, isPending: false }),
  useRemoveProjectMcpServer: () => ({ mutateAsync: removeMock, isPending: false, variables: undefined }),
  useSetProjectMcpServerAudience: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@multica/core/labels", () => ({
  labelListOptions: () => ({ queryKey: ["agent-labels"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  workspaceMcpServersOptions: () => ({ queryKey: ["workspace-mcp"], queryFn: vi.fn() }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: vi.fn() }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectMcpServersSection } from "./project-mcp-servers-section";

describe("ProjectMcpServersSection", () => {
  beforeEach(() => {
    addMock.mockClear();
    removeMock.mockClear();
    library = [ATTACHED, AVAILABLE];
  });

  it("lists attached servers and removes one", async () => {
    renderWithI18n(<ProjectMcpServersSection projectId="p1" canManage />);
    expect(screen.getByText("linear")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove linear" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("srv-1"));
  });

  it("attaches an unattached library server", async () => {
    renderWithI18n(<ProjectMcpServersSection projectId="p1" canManage />);

    fireEvent.click(screen.getByRole("button", { name: /add mcp server/i }));
    expect(screen.queryByRole("menuitem", { name: /linear/ })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: /postgres/ }));

    await waitFor(() => expect(addMock).toHaveBeenCalledWith(["srv-2"]));
  });

  it("explains a disabled add when every library server is attached", () => {
    library = [ATTACHED];
    renderWithI18n(<ProjectMcpServersSection projectId="p1" canManage />);
    expect((screen.getByRole("button", { name: /add mcp server/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already attached to this project/i)).toBeTruthy();
  });

  it("hides attach and detach controls from members who cannot manage them", () => {
    renderWithI18n(<ProjectMcpServersSection projectId="p1" canManage={false} />);
    expect(screen.getByText("linear")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add mcp server/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove linear" })).toBeNull();
  });
});
