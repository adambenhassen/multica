import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { RunAssigneeButton } from "./run-assignee-button";

const dispatchReasonCodeMock = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({ api: { rerunIssue: vi.fn() }, dispatchReasonCode: dispatchReasonCodeMock }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(assigneeType: Issue["assignee_type"], assigneeId: Issue["assignee_id"]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <RunAssigneeButton issueId="issue-1" assigneeType={assigneeType} assigneeId={assigneeId} />
    </QueryClientProvider>,
  );
}

describe("RunAssigneeButton", () => {
  it("renders nothing without an agent or squad assignee", () => {
    setup("member", "user-1");
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    cleanup();
    setup(null, null);
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("runs the assignee, continuing its session", async () => {
    vi.mocked(api.rerunIssue).mockResolvedValue({} as never);
    setup("agent", "agent-1");
    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(api.rerunIssue).toHaveBeenCalledWith("issue-1", undefined, { continue: true }));
  });

  it("explains a run blocked by invoke permission", async () => {
    vi.mocked(api.rerunIssue).mockRejectedValue(new Error("forbidden"));
    dispatchReasonCodeMock.mockReturnValue("invocation_not_allowed");
    setup("squad", "squad-1");
    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Not started — you don't have permission to use this agent"),
    );
  });

  it("explains a run blocked by Triage", async () => {
    vi.mocked(api.rerunIssue).mockRejectedValue(new Error("forbidden"));
    dispatchReasonCodeMock.mockReturnValue("issue_in_triage");
    setup("agent", "agent-1");
    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Issues in Triage can't be run"));
  });

  it("reports a run already waiting to start as information", async () => {
    vi.mocked(api.rerunIssue).mockRejectedValue(new Error("conflict"));
    dispatchReasonCodeMock.mockReturnValue("already_active");
    setup("agent", "agent-1");
    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("A run is already waiting to start"));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
