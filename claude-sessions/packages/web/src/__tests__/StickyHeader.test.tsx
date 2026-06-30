// AI-generated. See PROMPT.md for the prompts and model used.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StickyHeader } from "../components/transcript/StickyHeader";
import { fixtureSession } from "./fixtures";

describe("StickyHeader (REQ-024)", () => {
  it("renders all 6 spans: repo, branch, PR, model, duration, cost", () => {
    render(
      <MemoryRouter>
        <StickyHeader session={fixtureSession()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("hdr-repo")).toHaveTextContent("example/vibe-tools");
    expect(screen.getByTestId("hdr-branch")).toHaveTextContent("master");
    expect(screen.getByTestId("hdr-pr")).toHaveTextContent("#5");
    expect(screen.getByTestId("hdr-model")).toHaveTextContent("sonnet");
    expect(screen.getByTestId("hdr-duration")).toHaveTextContent(/7m/);
    expect(screen.getByTestId("hdr-cost")).toHaveTextContent("$0.21");
  });

  it("renders 'no PR' when there are no PRs referenced", () => {
    render(
      <MemoryRouter>
        <StickyHeader
          session={fixtureSession({
            summary: { ...fixtureSession().summary!, prs_referenced: [] },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("hdr-pr")).toHaveTextContent("no PR");
  });
});
