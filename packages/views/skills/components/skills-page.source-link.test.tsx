// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { SkillSummary } from "@multica/core/types";
import type { SupportedLocale } from "@multica/core/i18n";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

// Regression rig for the Source cell's anchor living inside a `useRowLink`
// row: the row handles BOTH click and auxclick, so the anchor must stop both
// from bubbling. Stopping only click let a middle click reach the row, whose
// preventDefault() cancelled the anchor's native open — the skill detail page
// opened in a background tab instead of the source page.

const mocks = vi.hoisted(() => ({
  skills: [] as SkillSummary[],
  usage: [] as { skill_id: string; run_count: number; last_used_at: string | null }[],
  usageState: { isPending: false, error: null as Error | null },
  viewState: {
    sortField: "name",
    sortDirection: "asc" as string,
    hiddenColumns: [] as string[],
    filters: {
      usage: [] as string[],
      origins: [] as string[],
      agents: [] as string[],
      creators: [] as string[],
      labels: [] as string[],
    },
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
    if (options.queryKey?.[0] === "skills") {
      return {
        data: mocks.skills,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (options.queryKey?.[0] === "skill-usage") {
      return {
        data: mocks.usage,
        isLoading: false,
        isPending: mocks.usageState.isPending,
        error: mocks.usageState.error,
        refetch: vi.fn(),
      };
    }
    return { data: [], isLoading: false, error: null, refetch: vi.fn() };
  },
}));

// Render every row so the anchor under test is always mounted.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 48,
        end: (index + 1) * 48,
        size: 48,
      })),
    getTotalSize: () => count * 48,
  }),
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

// Partial mock: SkillIcon resolves its icon from the real WORKSPACE_PAGES.
vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({
    skillDetail: (id: string) => `/acme/skills/${id}`,
  }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  skillListOptions: () => ({ queryKey: ["skills"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
  skillUsageOptions: () => ({ queryKey: ["skill-usage"] }),
  selectSkillAssignments: () => new Map(),
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
  runtimeDisplayLabel: () => "runtime",
}));

vi.mock("@multica/core/workspace/avatar-url", () => ({
  resolvePublicFileUrl: (u: string | null) => u,
}));

vi.mock("@multica/core/skills/stores", () => ({
  useSkillsViewStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.viewState),
  DEFAULT_HIDDEN_COLUMNS: [],
}));

// View-layer children with heavy / portal deps — stubbed to keep the test on
// the row/anchor event wiring.
vi.mock("@multica/ui/components/common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: () => null,
}));
vi.mock("./create-skill-dialog", () => ({ CreateSkillDialog: () => null }));
vi.mock("./skill-list-toolbar", () => ({ SkillListToolbar: () => null }));
vi.mock("./skill-list-actions", () => ({
  SkillBatchToolbar: () => null,
  SkillRowActions: () => null,
}));

import SkillsPage from "./skills-page";

const SOURCE_URL = "https://github.com/anthropics/skills/tree/main/animations";

const importedSkill: SkillSummary = {
  id: "skill-1",
  workspace_id: "ws-1",
  name: "animations",
  description: "",
  config: { origin: { type: "github", source_url: SOURCE_URL } },
  created_by: "user-1",
  created_at: "2026-07-28T18:11:37Z",
  updated_at: "2026-07-28T18:14:40Z",
};

function makeAdapter(
  overrides: Partial<NavigationAdapter> = {},
): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/skills",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    openInNewTab: vi.fn(),
    ...overrides,
  };
}

function renderPage(adapter: NavigationAdapter, locale?: SupportedLocale) {
  return renderWithI18n(
    <NavigationProvider value={adapter}>
      <SkillsPage />
    </NavigationProvider>,
    { locale },
  );
}

function middleClick(target: Element): MouseEvent {
  const event = new MouseEvent("auxclick", {
    bubbles: true,
    button: 1,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills = [importedSkill];
  mocks.usage = [];
  mocks.usageState.isPending = false;
  mocks.usageState.error = null;
  mocks.viewState.sortField = "name";
  mocks.viewState.sortDirection = "asc";
});

describe("SkillsPage source link vs row navigation", () => {
  it("middle click on the source link keeps its native open (row must not hijack)", async () => {
    const adapter = makeAdapter();
    renderPage(adapter);

    const link = await screen.findByRole("link", { name: "From GitHub" });
    expect(link.getAttribute("href")).toBe(SOURCE_URL);

    const event = middleClick(link);

    // The anchor's native middle-click open must survive: the row's auxclick
    // handler (which calls preventDefault) must never see the event.
    expect(event.defaultPrevented).toBe(false);
    expect(adapter.openInNewTab).not.toHaveBeenCalled();
    expect(adapter.push).not.toHaveBeenCalled();
  });

  it("left click on the source link does not trigger row navigation", async () => {
    const adapter = makeAdapter();
    renderPage(adapter);

    fireEvent.click(
      await screen.findByRole("link", { name: "From GitHub" }),
    );

    expect(adapter.push).not.toHaveBeenCalled();
    expect(adapter.openInNewTab).not.toHaveBeenCalled();
  });

  // Sanity check that the rig exercises the row's auxclick handler at all —
  // without this, the assertions above could pass vacuously.
  it("middle click elsewhere on the row still background-tabs the skill", async () => {
    const adapter = makeAdapter();
    renderPage(adapter);

    const event = middleClick(await screen.findByText("animations"));

    expect(event.defaultPrevented).toBe(true);
    expect(adapter.openInNewTab).toHaveBeenCalledWith(
      "/acme/skills/skill-1",
      "animations",
    );
  });
});

describe("SkillsPage docs link", () => {
  it("points Learn more at the viewer's docs locale", () => {
    renderPage(makeAdapter(), "fr");

    expect(
      screen.getByRole("link", { name: "En savoir plus →" }),
    ).toHaveAttribute("href", "https://multica.ai/docs/fr/skills");
  });
});

describe("SkillsPage project skills", () => {
  it("lists project skills in their own group with the projects they serve", async () => {
    mocks.skills = [
      importedSkill,
      {
        ...importedSkill,
        id: "skill-2",
        name: "project-conventions-lampahub",
        config: {},
        projects: [
          { id: "p1", title: "lampahub.com" },
          { id: "p2", title: "teagram-server" },
        ],
      },
    ];
    renderPage(makeAdapter());

    expect(await screen.findByText("Project skills")).toBeTruthy();
    expect(screen.getByText("Other skills")).toBeTruthy();
    expect(screen.getByText("lampahub.com, teagram-server")).toBeTruthy();
    // A project skill is in use even with no agent assigned.
    expect(screen.queryAllByText("— unused")).toHaveLength(1);
  });
});

describe("SkillsPage usage columns", () => {
  it("shows run count and last use, and a dash for an unused skill", async () => {
    mocks.skills = [importedSkill, { ...importedSkill, id: "skill-2", name: "never-run", config: {} }];
    mocks.usage = [
      { skill_id: "skill-1", run_count: 7, last_used_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
    ];
    renderPage(makeAdapter());

    expect(await screen.findByText("Runs")).toBeTruthy();
    expect(screen.getByText("Last used")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    // never-run: no runs and no last use.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("sorts by runs, most first", async () => {
    mocks.viewState.sortField = "runs";
    mocks.viewState.sortDirection = "desc";
    mocks.skills = [
      { ...importedSkill, id: "a", name: "alpha", config: {} },
      { ...importedSkill, id: "b", name: "bravo", config: {} },
    ];
    mocks.usage = [
      { skill_id: "a", run_count: 1, last_used_at: "2026-10-16T09:30:00Z" },
      { skill_id: "b", run_count: 5, last_used_at: "2026-10-16T09:30:00Z" },
    ];
    renderPage(makeAdapter());

    const names = (await screen.findAllByText(/^(alpha|bravo)$/)).map((el) => el.textContent);
    expect(names).toEqual(["bravo", "alpha"]);
  });

  it("sorts never-used skills last by last use", async () => {
    mocks.viewState.sortField = "lastUsed";
    mocks.viewState.sortDirection = "asc";
    mocks.skills = [
      { ...importedSkill, id: "a", name: "alpha", config: {} },
      { ...importedSkill, id: "b", name: "bravo", config: {} },
      { ...importedSkill, id: "c", name: "charlie", config: {} },
    ];
    mocks.usage = [
      { skill_id: "b", run_count: 1, last_used_at: "2026-10-16T09:30:00Z" },
      { skill_id: "c", run_count: 1, last_used_at: "2026-10-01T09:30:00Z" },
    ];
    renderPage(makeAdapter());

    const names = (await screen.findAllByText(/^(alpha|bravo|charlie)$/)).map((el) => el.textContent);
    expect(names).toEqual(["charlie", "bravo", "alpha"]);
  });

  it("sorts by last use descending, never-used last, ties by name", async () => {
    mocks.viewState.sortField = "lastUsed";
    mocks.viewState.sortDirection = "desc";
    mocks.skills = [
      { ...importedSkill, id: "a", name: "alpha", config: {} },
      { ...importedSkill, id: "b", name: "bravo", config: {} },
      { ...importedSkill, id: "c", name: "charlie", config: {} },
      { ...importedSkill, id: "d", name: "delta", config: {} },
    ];
    mocks.usage = [
      { skill_id: "d", run_count: 1, last_used_at: "2026-10-16T09:30:00Z" },
      { skill_id: "b", run_count: 1, last_used_at: "2026-10-16T09:30:00Z" },
      { skill_id: "c", run_count: 1, last_used_at: "2026-10-01T09:30:00Z" },
    ];
    renderPage(makeAdapter());

    const names = (await screen.findAllByText(/^(alpha|bravo|charlie|delta)$/)).map((el) => el.textContent);
    expect(names).toEqual(["bravo", "delta", "charlie", "alpha"]);
  });

  it("holds the skeleton while usage is pending under a usage sort", async () => {
    mocks.viewState.sortField = "runs";
    mocks.viewState.sortDirection = "desc";
    mocks.skills = [
      { ...importedSkill, id: "a", name: "alpha", config: {} },
      { ...importedSkill, id: "b", name: "bravo", config: {} },
    ];
    mocks.usage = [];
    mocks.usageState.isPending = true;
    const { container } = renderPage(makeAdapter());

    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("bravo")).toBeNull();
  });

  it("renders rows in usage order once usage resolves", async () => {
    mocks.viewState.sortField = "runs";
    mocks.viewState.sortDirection = "desc";
    mocks.skills = [
      { ...importedSkill, id: "a", name: "alpha", config: {} },
      { ...importedSkill, id: "b", name: "bravo", config: {} },
    ];
    mocks.usage = [{ skill_id: "b", run_count: 5, last_used_at: null }];
    const { container } = renderPage(makeAdapter());

    const names = (await screen.findAllByText(/^(alpha|bravo)$/)).map((el) => el.textContent);
    expect(names).toEqual(["bravo", "alpha"]);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("does not hold the skeleton for a non-usage sort", async () => {
    mocks.usageState.isPending = true;
    renderPage(makeAdapter());

    expect(await screen.findByText("animations")).toBeTruthy();
  });

  it("warns about missing usage figures and still renders rows when usage fails", async () => {
    mocks.viewState.sortField = "runs";
    mocks.usageState.error = new Error("boom");
    renderPage(makeAdapter());

    expect(await screen.findByText("animations")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "usage figures (runs and last used)",
    );
  });

  it("formats the run count with the locale and right-aligns the column", async () => {
    mocks.usage = [{ skill_id: "skill-1", run_count: 12345, last_used_at: null }];
    renderPage(makeAdapter(), "fr");

    const cell = await screen.findByText(/^12\s?345$/);
    expect(cell.className).toContain("justify-end");
    expect(screen.getByRole("columnheader", { name: "Exécutions" }).className).toContain("justify-end");
  });
});
