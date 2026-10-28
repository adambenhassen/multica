import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { Agent } from "@multica/core/types";
import type { SupportedLocale } from "@multica/core/i18n";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { AgentsPage } from "./agents-page";

// These tests pin the `listReady` render gate (MUL-4511): the Agents list must
// not paint real rows until the auxiliary queries the active sort field /
// filter depends on have landed, or it sorts on placeholder values
// (lastRunAt null, runCount 0) and visibly re-orders when each query
// resolves. The gate waits per need — nothing for name/created, run-counts
// for runs and the default lastActive,
// presence when an availability filter is active — and never blocks the empty
// state on those queries.

const mocks = vi.hoisted(() => ({
  agents: [] as Agent[],
  agentsLoading: false,
  runCounts: [] as Array<{
    agent_id: string;
    run_count: number;
    last_hour_count?: number;
    last_run_at: string | null;
  }>,
  runCountsPending: false,
  presence: {
    byAgent: new Map<string, unknown>(),
    loading: false,
  },
  viewState: {
    scope: "all",
    sortField: "lastActive" as string,
    sortDirection: "desc" as string,
    hiddenColumns: ["created"] as string[],
    filters: {
      availability: [] as string[],
      runtimes: [] as string[],
      owners: [] as string[],
      models: [] as string[],
      access: [] as string[],
    },
    search: "",
    setSearch: vi.fn(),
    setScope: vi.fn(),
    toggleSort: vi.fn(),
    setSortField: vi.fn(),
    setSortDirection: vi.fn(),
    toggleColumn: vi.fn(),
    toggleFilter: vi.fn(),
    clearFilters: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey?.[0];
    if (key === "agents") {
      return {
        data: mocks.agents,
        isLoading: mocks.agentsLoading,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key === "agent-run-counts") {
      return { data: mocks.runCounts, isPending: mocks.runCountsPending };
    }
    return { data: [], isLoading: false, isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// The list virtualizes; render every row so DOM order reflects sort order.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        end: (index + 1) * 64,
        size: 64,
      })),
    getTotalSize: () => count * 64,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@multica/core/agents", () => ({
  isAgentRuntimeBound: (agent: { runtime_id: string; runtime_bound?: boolean }) =>
    agent.runtime_bound !== false && agent.runtime_id.length > 0,
  agentRunCounts30dOptions: () => ({ queryKey: ["agent-run-counts"] }),
  useWorkspacePresenceMap: () => mocks.presence,
  VISIBILITY_TOOLTIP: { private: "Private", workspace: "Workspace" },
  effectiveAccessScope: (pm: unknown, it: unknown) => {
    if (pm !== "public_to") return "owner-only";
    if ((Array.isArray(it) ? it : []).some((t) => (t as {target_type?: string})?.target_type === "workspace")) return "workspace";
    return "specific-people";
  },
  ALL_ACCESS_SCOPES: ["workspace", "specific-people", "owner-only"],
}));

vi.mock("@multica/core/agents/stores", () => ({
  useAgentsViewStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.viewState),
  AGENT_DEFAULT_HIDDEN_COLUMNS: ["created"],
  AGENT_SCOPES: ["mine", "all", "archived"],
}));

vi.mock("@multica/core/api", () => ({
  api: { archiveAgent: vi.fn(), restoreAgent: vi.fn() },
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    newAgent: () => "/test-workspace/agents/new",
    newAgentManual: () => "/test-workspace/agents/new/manual",
    agentDetail: (id: string) => `/test-workspace/agents/${id}`,
  }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
  workspaceKeys: { agents: (wsId: string) => ["agents", wsId] },
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
}));

// View-layer children with heavy / portal deps — stub to keep the test focused
// on the gate, not on avatars, row menus, the toolbar, or tooltip portals.
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("./agent-row-actions", () => ({ AgentRowActions: () => null }));
vi.mock("./agent-list-toolbar", () => ({
  AgentListToolbar: () => <div data-testid="agent-list-toolbar" />,
  countActiveFilterDimensions: () => 0,
}));
vi.mock("../presence", () => ({ availabilityConfig: {} }));
vi.mock("@multica/ui/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => (
    <div data-testid="skeleton" {...props} />
  ),
}));
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

const BASE_AGENT: Agent = {
  id: "agent-base",
  workspace_id: "workspace-1",
  runtime_id: "runtime-1",
  name: "Base Agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "cloud",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  permission_mode: "private",
  invocation_targets: [],
  status: "idle",
  max_concurrent_tasks: 1,
  model: "claude",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

function makeAgent(over: Partial<Agent>): Agent {
  return { ...BASE_AGENT, ...over };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const ALPHA = makeAgent({ id: "a-alpha", name: "Alpha Agent" });
const BETA = makeAgent({ id: "a-beta", name: "Beta Agent" });

function makeAdapter(
  overrides: Partial<NavigationAdapter> = {},
): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/test-workspace/agents",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    ...overrides,
  };
}

function renderPage(locale?: SupportedLocale) {
  renderWithI18n(
    <NavigationProvider value={makeAdapter()}>
      <AgentsPage />
    </NavigationProvider>,
    { locale },
  );
}

/** Beta before Alpha in document order? */
function betaPrecedesAlpha(): boolean {
  const alpha = screen.getByText("Alpha Agent");
  const beta = screen.getByText("Beta Agent");
  return Boolean(
    beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

beforeEach(() => {
  mocks.agents = [ALPHA, BETA];
  mocks.agentsLoading = false;
  mocks.runCounts = [];
  mocks.runCountsPending = false;
  mocks.presence = { byAgent: new Map(), loading: false };
  mocks.viewState.scope = "all";
  mocks.viewState.sortField = "lastActive";
  mocks.viewState.sortDirection = "desc";
  mocks.viewState.hiddenColumns = ["created"];
  mocks.viewState.search = "";
  mocks.viewState.filters = {
    availability: [],
    runtimes: [],
    owners: [],
    models: [],
    access: [],
  };
});

describe("AgentsPage listReady gate", () => {
  it("shows only a skeleton (no real rows) while lastActive deps are pending", () => {
    // Default lastActive sort depends on run-counts (it carries last_run_at).
    mocks.runCountsPending = true;

    renderPage();

    expect(screen.queryByText("Alpha Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta Agent")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("renders rows in the resolved lastActive order once deps land", () => {
    // Alpha ran 3h ago, Beta 5m ago — both "today" — and lastActive desc
    // puts Beta first, the opposite of the name-order fallback the ungated
    // list would show.
    mocks.runCounts = [
      { agent_id: ALPHA.id, run_count: 0, last_run_at: minutesAgo(180) },
      { agent_id: BETA.id, run_count: 0, last_run_at: minutesAgo(5) },
    ];
    mocks.runCountsPending = false;

    renderPage();

    expect(screen.getByText("Alpha Agent")).toBeInTheDocument();
    expect(screen.getByText("Beta Agent")).toBeInTheDocument();
    expect(betaPrecedesAlpha()).toBe(true);
    expect(screen.getByText("3h ago")).toBeInTheDocument();
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("renders rows immediately for name sort without waiting on run-counts/presence", () => {
    mocks.viewState.sortField = "name";
    mocks.viewState.sortDirection = "asc";
    // Auxiliary queries are still in flight — name sort must not wait on them.
    mocks.runCountsPending = true;
    mocks.presence = { byAgent: new Map(), loading: true };

    renderPage();

    expect(screen.getByText("Alpha Agent")).toBeInTheDocument();
    expect(screen.getByText("Beta Agent")).toBeInTheDocument();
    // name asc → Alpha before Beta.
    expect(betaPrecedesAlpha()).toBe(false);
  });

  it("shows a skeleton (not a false empty/false result) while an availability filter waits on presence", () => {
    // Availability filter needs presence; sort by name so ONLY presence gates.
    // Ungated, presence-null rows would all be filtered out → a false "no
    // matches" state. Gated, we hold on a skeleton instead.
    mocks.viewState.sortField = "name";
    mocks.viewState.filters.availability = ["online"];
    mocks.presence = { byAgent: new Map(), loading: true };

    renderPage();

    expect(screen.queryByText("Alpha Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta Agent")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("shows the empty state without blocking on auxiliary queries when there are no agents", () => {
    mocks.agents = [];
    // All auxiliary queries pending — the empty state must not wait on them.
    mocks.runCountsPending = true;
    mocks.presence = { byAgent: new Map(), loading: true };

    renderPage();

    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
  });
});

describe("AgentsPage docs link", () => {
  it("points Learn more at the viewer's docs locale", () => {
    renderPage("fr");

    expect(
      screen.getByRole("link", { name: "En savoir plus →" }),
    ).toHaveAttribute("href", "https://multica.ai/docs/fr/agents");
  });
});

describe("AgentsPage model and concurrency columns", () => {
  it("shows the reasoning level beside the model when the agent pins one", () => {
    mocks.viewState.hiddenColumns = ["created"];
    mocks.agents = [
      makeAgent({ id: "a-alpha", name: "Alpha Agent", model: "claude-opus", thinking_level: "high" }),
      makeAgent({ id: "a-beta", name: "Beta Agent", model: "gpt-luna", thinking_level: "" }),
    ];

    renderPage();

    expect(screen.getByText("claude-opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("gpt-luna").parentElement?.children).toHaveLength(1);
  });

  it("shows each agent's max concurrent runs in the Concurrency column", () => {
    mocks.viewState.sortField = "name";
    mocks.viewState.sortDirection = "asc";
    mocks.agents = [makeAgent({ id: "a-alpha", name: "Alpha Agent", max_concurrent_tasks: 7 })];

    renderPage();

    expect(screen.getByRole("columnheader", { name: "Concurrency" })).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("shows each agent's runs from the last hour and sorts by them", () => {
    mocks.viewState.sortField = "lastHour";
    mocks.viewState.sortDirection = "desc";
    mocks.runCounts = [
      { agent_id: ALPHA.id, run_count: 40, last_hour_count: 2, last_run_at: null },
      { agent_id: BETA.id, run_count: 30, last_hour_count: 9, last_run_at: null },
    ];

    renderPage();

    expect(screen.getByRole("columnheader", { name: "Last hour" })).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(betaPrecedesAlpha()).toBe(true);
  });
});

describe("AgentsPage search + model column (GitHub #9500)", () => {
  it("filters by the store's search query so it survives leaving the page", () => {
    // The query comes from the view store, not page-local state: a remount
    // (open agent → back) renders with the same query already applied.
    mocks.viewState.sortField = "name";
    mocks.viewState.search = "beta";

    renderPage();

    expect(screen.getByText("Beta Agent")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Agent")).not.toBeInTheDocument();
  });

  it("renders the model column by default", () => {
    mocks.viewState.sortField = "name";

    renderPage();

    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getAllByTitle("claude").length).toBeGreaterThan(0);
  });
});
