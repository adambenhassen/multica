import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResponse } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { ProviderQuotaPanel } from "./provider-quota-panel";

const quota = vi.hoisted(() => ({ current: undefined as ProviderQuotaResponse | undefined }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: quota.current }),
}));

const NOW = Date.parse("2026-10-29T12:00:00Z");
const claude = (label: string, session: number, weekly: number) => ({
  id: `claude-${label}`, provider: "claude" as const, label, error: null, updated_at: null,
  windows: [
    { kind: "session" as const, used_percent: session, resets_at: "2026-10-29T14:10:00Z" },
    { kind: "weekly" as const, used_percent: weekly, resets_at: "2026-11-02T13:00:00Z" },
  ],
});
const codex = (label: string, weekly: number) => ({
  id: `codex-${label}`, provider: "codex" as const, label, error: null, updated_at: null,
  windows: [{ kind: "weekly" as const, used_percent: weekly, resets_at: "2026-10-31T12:00:00Z" }],
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  quota.current = undefined;
});

describe("ProviderQuotaPanel", () => {
  it("renders nothing while loading or when there are no accounts", () => {
    const { container, rerender } = renderWithI18n(<ProviderQuotaPanel />);
    expect(container).toBeEmptyDOMElement();
    quota.current = { accounts: [] };
    rerender(<ProviderQuotaPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders Claude session + weekly and Codex weekly", () => {
    quota.current = { accounts: [codex("personal", 61), claude("personal", 42, 18)] };
    renderWithI18n(<ProviderQuotaPanel />);

    const rows = screen.getAllByRole("progressbar");
    expect(rows.map((r) => r.getAttribute("aria-valuenow"))).toEqual(["42", "18", "61"]);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getAllByText("Session")).toHaveLength(1);
    expect(screen.getAllByText("Weekly")).toHaveLength(2);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("2h 10m")).toBeInTheDocument();
    expect(screen.getByText("4d")).toBeInTheDocument();
    expect(screen.getByText("2d")).toBeInTheDocument();
  });

  it("renders a Claude Fable window as a third row after Weekly", () => {
    const acct = claude("personal", 42, 18);
    quota.current = {
      accounts: [
        { ...acct, windows: [...acct.windows, { kind: "fable" as const, used_percent: 55, resets_at: "2026-11-02T13:00:00Z" }] },
      ],
    };
    renderWithI18n(<ProviderQuotaPanel />);
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["42", "18", "55"]);
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Claude Session", "Claude Weekly", "Claude Fable",
    ]);
    expect(screen.getByText("Fable")).toBeInTheDocument();
  });

  it("appends the label only when a provider has several accounts", () => {
    quota.current = { accounts: [claude("work", 1, 1), claude("personal", 1, 1), codex("personal", 1)] };
    renderWithI18n(<ProviderQuotaPanel />);
    expect(screen.getByText("Claude · personal")).toBeInTheDocument();
    expect(screen.getByText("Claude · work")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("gives each account of a multi-account provider a full-width plain header row", () => {
    quota.current = { accounts: [claude("work", 1, 1), claude("personal", 1, 1)] };
    renderWithI18n(<ProviderQuotaPanel />);
    for (const text of ["Claude · personal", "Claude · work"]) {
      const header = screen.getByText(text);
      expect(header).toHaveClass("col-span-full");
      expect(header).not.toHaveAttribute("tabindex");
    }
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Claude · work Session" })).toBeInTheDocument();
  });

  it("gives a single-account provider a header row too when another provider has several", () => {
    quota.current = { accounts: [claude("account-1", 0, 100), claude("account-2", 24, 4), codex("account", 33)] };
    renderWithI18n(<ProviderQuotaPanel />);
    expect(screen.getByText("Codex")).toHaveClass("col-span-full");
    expect(screen.getByRole("progressbar", { name: "Codex Weekly" })).toBeInTheDocument();
  });

  it("renders a header then a focusable dash row for a multi-account errored account", () => {
    quota.current = {
      accounts: [{ ...codex("old", 0), windows: [], error: "login_expired" }, codex("personal", 61)],
    };
    renderWithI18n(<ProviderQuotaPanel />);
    const header = screen.getByText("Codex · old");
    expect(header).toHaveClass("col-span-full");
    expect(header).not.toHaveAttribute("tabindex");
    const dash = screen.getByText("—");
    expect(dash.closest('[tabindex="0"]')).toBeInTheDocument();
    expect(screen.getByText("Login expired", { selector: ".sr-only" })).toBeInTheDocument();
  });

  it("colours bars by threshold", () => {
    quota.current = { accounts: [claude("personal", 80, 95)] };
    renderWithI18n(<ProviderQuotaPanel />);
    const [session, weekly] = screen.getAllByRole("progressbar");
    expect(session!.firstElementChild).toHaveClass("bg-warning");
    expect(weekly!.firstElementChild).toHaveClass("bg-destructive");
  });

  it("shows a dash for an errored account", () => {
    quota.current = { accounts: [{ ...codex("personal", 0), windows: [], error: "login_expired" }] };
    renderWithI18n(<ProviderQuotaPanel />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("makes an errored row keyboard-focusable with an accessible reason", () => {
    quota.current = { accounts: [{ ...codex("personal", 0), windows: [], error: "login_expired" }] };
    renderWithI18n(<ProviderQuotaPanel />);
    const reason = screen.getByText("Login expired", { selector: ".sr-only" });
    expect(reason.closest('[tabindex="0"]')).toBeInTheDocument();
  });

  it("colours by the rounded percent that is displayed", () => {
    quota.current = { accounts: [codex("personal", 79.6)] };
    renderWithI18n(<ProviderQuotaPanel />);
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar").firstElementChild).toHaveClass("bg-warning");
  });

  it("names each progressbar after its account", () => {
    quota.current = { accounts: [claude("personal", 42, 18)] };
    renderWithI18n(<ProviderQuotaPanel />);
    expect(screen.getByRole("progressbar", { name: "Claude Session" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Claude Weekly" })).toBeInTheDocument();
  });
});
