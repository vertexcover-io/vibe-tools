// AI-generated. See PROMPT.md for the prompts and model used.

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import type { TranscriptEvent } from "../../lib/types";

interface Props {
  event: TranscriptEvent;
}

export const ToolCallCollapsed = ({ event }: Props) => {
  const [open, setOpen] = useState(false);
  const tool = event.payload.tool ?? "tool";
  const inputSummary = event.payload.input_summary ?? "";
  const outputSummary = event.payload.output_summary ?? "";
  const isError = event.payload.is_error === true;

  return (
    <div
      className={cn(
        "tool-call collapsed border border-border rounded my-2",
        isError && "border-red-500/40",
      )}
      data-testid="tool-call"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left p-2 font-mono text-sm flex items-center gap-1 hover:bg-accent"
        data-testid="tool-toggle"
        aria-expanded={open}
      >
        <ChevronRight
          size={14}
          className={cn("transition-transform shrink-0", open && "rotate-90")}
        />
        <span className="font-semibold">{tool}</span>
        <span className="text-muted-foreground ml-2 truncate flex-1">{inputSummary}</span>
        {isError && <span className="text-xs text-red-500 font-medium">error</span>}
      </button>
      {open && (
        <div
          className="border-t border-border p-2 font-mono text-xs whitespace-pre-wrap bg-muted"
          data-testid="tool-body"
        >
          <div>
            <span className="text-muted-foreground">in:</span> {inputSummary}
          </div>
          {outputSummary && (
            <div className="mt-1">
              <span className="text-muted-foreground">out:</span> {outputSummary}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
