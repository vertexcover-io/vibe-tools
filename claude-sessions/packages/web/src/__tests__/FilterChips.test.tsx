// AI-generated. See PROMPT.md for the prompts and model used.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FILTER_KEYS, FilterChips } from "../components/FilterChips";

const LocationProbe = ({ onChange }: { onChange: (search: string) => void }) => {
  const loc = useLocation();
  onChange(loc.search);
  return null;
};

describe("FilterChips (REQ-025)", () => {
  it("renders 6 chips: repo, branch, agent, model, has_pr, date", () => {
    render(
      <MemoryRouter initialEntries={["/repos/x"]}>
        <FilterChips />
      </MemoryRouter>,
    );
    const root = screen.getByTestId("filter-chips");
    const chips = root.querySelectorAll(".filter-chip");
    expect(chips).toHaveLength(FILTER_KEYS.length);
    expect(FILTER_KEYS.length).toBe(6);
    for (const k of FILTER_KEYS) {
      expect(screen.getByTestId(`filter-chip-${k}`)).toBeInTheDocument();
    }
  });

  it("toggling has_pr updates the URL search params", () => {
    const captured: string[] = [];
    render(
      <MemoryRouter initialEntries={["/repos/x"]}>
        <Routes>
          <Route
            path="/repos/x"
            element={
              <>
                <FilterChips />
                <LocationProbe onChange={(s) => captured.push(s)} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("filter-chip-has_pr"));
    const last = captured[captured.length - 1] ?? "";
    expect(last).toContain("has_pr=true");
  });

  it("clicking a text-input filter updates URL via window.prompt", () => {
    const captured: string[] = [];
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("master");
    render(
      <MemoryRouter initialEntries={["/repos/x"]}>
        <Routes>
          <Route
            path="/repos/x"
            element={
              <>
                <FilterChips />
                <LocationProbe onChange={(s) => captured.push(s)} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("filter-chip-branch"));
    const last = captured[captured.length - 1] ?? "";
    expect(last).toContain("branch=master");
    promptSpy.mockRestore();
  });
});
