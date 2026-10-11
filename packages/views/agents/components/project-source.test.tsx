// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectSourceBadge, ProjectSourceList } from "./project-source";

describe("ProjectSourceBadge", () => {
  it("names a single project and counts several", () => {
    const { rerender } = renderWithI18n(<ProjectSourceBadge projects={[{ id: "p1", title: "lampahub.com" }]} />);
    expect(screen.getByText("Also via lampahub.com")).toBeTruthy();
    rerender(
      <ProjectSourceBadge
        projects={[
          { id: "p1", title: "lampahub.com" },
          { id: "p2", title: "bringme" },
        ]}
      />,
    );
    expect(screen.getByText("Also via 2 projects")).toBeTruthy();
  });

  it("renders nothing when no project gives the item", () => {
    const { container } = renderWithI18n(<ProjectSourceBadge projects={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("ProjectSourceList", () => {
  it("links each project the item comes from", () => {
    renderWithI18n(
      <ProjectSourceList
        title="From projects"
        hint="hint"
        icon={null}
        items={[{ id: "s1", name: "deploy-target-lampahub", detail: "", projects: [{ id: "p1", title: "lampahub.com" }] }]}
      />,
    );
    expect(screen.getByText("deploy-target-lampahub")).toBeTruthy();
    expect(screen.getByRole("link", { name: "lampahub.com" }).getAttribute("href")).toBe("/ws/projects/p1");
  });
});
