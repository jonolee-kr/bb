// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabPill } from "./tab-pill";

afterEach(cleanup);

const EXPECTED_CLOSE_BUTTON_CLASS =
  "pointer-events-none absolute left-1.5 top-1/2 z-10 -translate-y-1/2 inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none max-md:pointer-coarse:size-5 opacity-0 hover:opacity-100 group-hover/tab-pill:pointer-events-auto group-hover/tab-pill:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-30 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";
const EXPECTED_CLOSABLE_LEADING_VISUAL_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5 max-md:pointer-coarse:size-5 max-md:pointer-coarse:[&_svg]:size-5 mr-1.5 group-hover/tab-pill:opacity-0 tab-pill-close-focus-visible:opacity-0 pointer-coarse:opacity-0";
const EXPECTED_LEADING_VISUAL_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5 max-md:pointer-coarse:size-5 max-md:pointer-coarse:[&_svg]:size-5 mr-1.5";

function getLeadingVisual() {
  const leadingVisual = screen.getByTestId("leading-visual").parentElement;
  if (!leadingVisual) {
    throw new Error("Expected a leading visual wrapper");
  }
  return leadingVisual;
}

function renderClosableTab() {
  render(
    <TabPill
      label="Browser"
      leadingVisual={<span data-testid="leading-visual">B</span>}
      title="Browser"
      isActive={false}
      onSelect={vi.fn()}
      closeAction={{ onClose: vi.fn(), closeLabel: "Close Browser" }}
    />,
  );

  return {
    closeButton: screen.getByRole("button", { name: "Close Browser" }),
    leadingVisual: getLeadingVisual(),
  };
}

describe("TabPill", () => {
  it("keeps an icon-only tab reachable by its accessible name", () => {
    render(
      <TabPill
        label="Info"
        ariaLabel="Show thread info panel"
        iconOnly
        leadingVisual={<span aria-hidden>i</span>}
        title="Thread info"
        isActive
        onSelect={vi.fn()}
        closeAction={null}
      />,
    );

    const tab = screen.getByRole("button", { name: "Show thread info panel" });
    expect(tab.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Info").classList).toContain("sr-only");
  });

  it("reports the pressed state of an inactive tab", () => {
    render(
      <TabPill
        label="Browser"
        title="Browser"
        isActive={false}
        onSelect={vi.fn()}
        closeAction={null}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Browser" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("reveals a close action for any coarse pointer", () => {
    const { closeButton } = renderClosableTab();

    expect(closeButton.className).toBe(EXPECTED_CLOSE_BUTTON_CLASS);
    expect(closeButton.classList).toContain("pointer-coarse:opacity-100");
    expect(closeButton.classList).toContain(
      "pointer-coarse:pointer-events-auto",
    );
  });

  it("hides a closable leading visual for any coarse pointer", () => {
    const { leadingVisual } = renderClosableTab();

    expect(leadingVisual.className).toBe(
      EXPECTED_CLOSABLE_LEADING_VISUAL_CLASS,
    );
    expect(leadingVisual.classList).toContain("pointer-coarse:opacity-0");
  });

  it("keeps the fine-pointer close reveal classes", () => {
    const { closeButton } = renderClosableTab();

    expect(closeButton.classList).toContain("hover:opacity-100");
    expect(closeButton.classList).toContain(
      "group-hover/tab-pill:pointer-events-auto",
    );
    expect(closeButton.classList).toContain(
      "group-hover/tab-pill:opacity-100",
    );
  });

  it("does not width-gate close visibility or pointer interaction", () => {
    const { closeButton, leadingVisual } = renderClosableTab();

    expect(closeButton.classList).not.toContain(
      "max-md:pointer-coarse:pointer-events-auto",
    );
    expect(closeButton.classList).not.toContain(
      "max-md:pointer-coarse:opacity-100",
    );
    expect(leadingVisual.classList).not.toContain(
      "max-md:pointer-coarse:opacity-0",
    );
  });

  it("keeps a leading visual visible without a close action", () => {
    render(
      <TabPill
        label="Browser"
        leadingVisual={<span data-testid="leading-visual">B</span>}
        title="Browser"
        isActive={false}
        onSelect={vi.fn()}
        closeAction={null}
      />,
    );

    const leadingVisual = getLeadingVisual();

    expect(leadingVisual.className).toBe(EXPECTED_LEADING_VISUAL_CLASS);
    expect(leadingVisual.classList).not.toContain("pointer-coarse:opacity-0");
  });
});
