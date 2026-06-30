// AI-generated. See PROMPT.md for the prompts and model used.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallCollapsed } from "../components/transcript/ToolCallCollapsed";
import type { TranscriptEvent } from "../lib/types";

const event: TranscriptEvent = {
  event_uuid: "t-1",
  parent_uuid: null,
  ts: "2026-05-01T10:00:00.000Z",
  type: "tool_use",
  payload: {
    tool: "Bash",
    tool_use_id: "tu-1",
    input_summary: "ls /tmp",
    output_summary: "drwx 1 root",
  },
};

describe("ToolCallCollapsed (REQ-024)", () => {
  it("renders collapsed by default with .tool-call.collapsed class", () => {
    const { container } = render(<ToolCallCollapsed event={event} />);
    expect(container.querySelector(".tool-call.collapsed")).toBeTruthy();
    expect(screen.queryByTestId("tool-body")).toBeNull();
  });

  it("expands and collapses on toggle click", () => {
    render(<ToolCallCollapsed event={event} />);
    const toggle = screen.getByTestId("tool-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("tool-body")).toBeInTheDocument();
    expect(screen.getByTestId("tool-body")).toHaveTextContent("ls /tmp");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("tool-body")).toBeNull();
  });
});
