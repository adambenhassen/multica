// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsNarrowerThan } from "./use-is-narrower-than";

/** jsdom has no layout: the width the element reports, and its observers. */
let width = 0;
let resize: Array<() => void> = [];

beforeEach(() => {
  width = 0;
  resize = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        resize.push(this.callback);
      }
      disconnect() {
        resize = resize.filter((callback) => callback !== this.callback);
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.fontSize = "";
});

function Probe({ rem }: { rem: number }) {
  const [ref, narrower] = useIsNarrowerThan<HTMLDivElement>(rem);
  return <div ref={ref}>{narrower ? "narrow" : "wide"}</div>;
}

function resizeTo(next: number) {
  width = next;
  act(() => resize.forEach((callback) => callback()));
}

describe("useIsNarrowerThan", () => {
  it("answers from the element's width on the first render", () => {
    width = 360;
    render(<Probe rem={32} />);
    expect(screen.getByText("narrow")).toBeTruthy();
  });

  it("follows the element as it resizes, exclusive of the threshold", () => {
    width = 800;
    render(<Probe rem={32} />);
    expect(screen.getByText("wide")).toBeTruthy();

    resizeTo(511);
    expect(screen.getByText("narrow")).toBeTruthy();
    resizeTo(512);
    expect(screen.getByText("wide")).toBeTruthy();
  });

  it("measures the threshold in root ems", () => {
    document.documentElement.style.fontSize = "20px";
    width = 600;
    render(<Probe rem={32} />);
    expect(screen.getByText("narrow")).toBeTruthy();
  });

  it("is not narrow where there is no layout to measure", () => {
    render(<Probe rem={32} />);
    expect(screen.getByText("wide")).toBeTruthy();
  });

  it("stops observing on unmount", () => {
    width = 360;
    const { unmount } = render(<Probe rem={32} />);
    expect(resize).toHaveLength(1);
    unmount();
    expect(resize).toHaveLength(0);
  });
});
