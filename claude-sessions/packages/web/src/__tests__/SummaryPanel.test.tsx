// AI-generated. See PROMPT.md for the prompts and model used.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SummaryPanel } from "../components/transcript/SummaryPanel";
import { fixtureSession, fixtureSummary } from "./fixtures";

const renderPanel = () =>
  render(
    <MemoryRouter>
      <SummaryPanel session={fixtureSession()} summary={fixtureSummary()} />
    </MemoryRouter>,
  );

describe("SummaryPanel", () => {
  it("renders title, summary text, tags, files and prs (REQ-024)", () => {
    renderPanel();
    expect(screen.getByText(/Build pin: CLI bookmark manager/)).toBeInTheDocument();
    expect(screen.getByText(/Designed and shipped pin/)).toBeInTheDocument();
    expect(screen.getByText("cli-tooling")).toBeInTheDocument();
    expect(screen.getByText("shipped")).toBeInTheDocument();
    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  it("collapses on click and re-expands", () => {
    renderPanel();
    const toggle = screen.getByTestId("summary-toggle");
    expect(screen.getByTestId("summary-body")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("summary-body")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("summary-body")).toBeInTheDocument();
  });

  it("renders the structural .session-summary-panel class (REQ-024)", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".session-summary-panel")).toBeTruthy();
  });

  it("clicking a tag chip navigates to /search?tag=...", () => {
    renderPanel();
    const tag = screen.getByText("cli-tooling");
    expect(tag.getAttribute("href")).toBe(`/search?tag=${encodeURIComponent("cli-tooling")}`);
  });
});
