// AI-generated. See PROMPT.md for the prompts and model used.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fixtureEvents, fixtureSession } from "./fixtures";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    useSession: () => ({
      data: fixtureSession(),
      isLoading: false,
      isError: false,
    }),
    useSessionEvents: () => ({
      data: { events: fixtureEvents() },
      isLoading: false,
      isError: false,
    }),
  };
});

import { SessionView } from "../pages/SessionView";

const renderRoute = (id: string) => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/sessions/${id}`]}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("SessionView (REQ-024)", () => {
  it("renders structural classes: .msg-user, .msg-assistant, .tool-call.collapsed, .session-summary-panel, sticky-header", () => {
    const { container } = renderRoute("fixture-session-1");
    expect(container.querySelector(".session-summary-panel")).toBeTruthy();
    expect(container.querySelector(".msg-user")).toBeTruthy();
    expect(container.querySelector(".msg-assistant")).toBeTruthy();
    expect(container.querySelector(".tool-call.collapsed")).toBeTruthy();
    expect(container.querySelector('[data-testid="sticky-header"]')).toBeTruthy();
  });
});
