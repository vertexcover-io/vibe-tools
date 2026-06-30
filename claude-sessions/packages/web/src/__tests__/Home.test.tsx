// AI-generated. See PROMPT.md for the prompts and model used.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fixtureRepo } from "./fixtures";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    useEnabledRepos: () => ({
      data: {
        repos: [
          fixtureRepo({ id: "r-1", canonical_url: "github.com/example/one" }),
          fixtureRepo({ id: "r-2", canonical_url: "github.com/example/two" }),
          fixtureRepo({ id: "r-3", canonical_url: "github.com/example/three" }),
        ],
      },
      isLoading: false,
      isError: false,
    }),
    useRecentSessions: () => ({
      data: { sessions: [] },
      isLoading: false,
      isError: false,
    }),
  };
});

import { HomePage } from "../pages/Home";

describe("Home page (REQ-023)", () => {
  it("renders one RepoTile per enabled repo", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const tiles = screen.getAllByTestId("repo-tile");
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toHaveTextContent("example/one");
    expect(tiles[1]).toHaveTextContent("example/two");
    expect(tiles[2]).toHaveTextContent("example/three");
  });
});
