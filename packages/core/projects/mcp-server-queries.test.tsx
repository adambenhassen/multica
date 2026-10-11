/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError, setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { useRemoveProjectMcpServer } from "./mcp-server-queries";

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useRemoveProjectMcpServer", () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("treats a server that is already detached as removed", async () => {
    const removeProjectMcpServer = vi
      .fn()
      .mockRejectedValue(new ApiError("project MCP server not found", 404, "Not Found"));
    setApiInstance({ removeProjectMcpServer } as unknown as ApiClient);

    const { result } = renderHook(() => useRemoveProjectMcpServer("ws-1", "p1"), {
      wrapper: createWrapper(qc),
    });
    await act(async () => {
      await result.current.mutateAsync("srv-1");
    });
    expect(removeProjectMcpServer).toHaveBeenCalledWith("p1", "srv-1");
  });

  it("still surfaces other failures", async () => {
    const removeProjectMcpServer = vi
      .fn()
      .mockRejectedValue(new ApiError("insufficient permissions", 403, "Forbidden"));
    setApiInstance({ removeProjectMcpServer } as unknown as ApiClient);

    const { result } = renderHook(() => useRemoveProjectMcpServer("ws-1", "p1"), {
      wrapper: createWrapper(qc),
    });
    await expect(
      act(async () => {
        await result.current.mutateAsync("srv-1");
      }),
    ).rejects.toThrow("insufficient permissions");
  });
});
