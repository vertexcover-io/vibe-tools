// AI-generated. See PROMPT.md for the prompts and model used.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { TranscriptEvent } from "../../lib/types";
import { AssistantMessage } from "./AssistantMessage";
import { ToolCallCollapsed } from "./ToolCallCollapsed";
import { UserMessage } from "./UserMessage";

interface Props {
  events: TranscriptEvent[];
}

// Below this size we render every event up-front. Virtualization adds latency
// for short transcripts and pessimizes test environments (jsdom reports zero
// scroll height). The threshold matches Lighthouse's "interactive" budget.
const VIRTUALIZE_THRESHOLD = 50;

const renderEvent = (event: TranscriptEvent) => {
  switch (event.type) {
    case "user_msg":
      return <UserMessage content={event.payload.content_md ?? ""} />;
    case "assistant_msg":
      return (
        <AssistantMessage
          content={event.payload.content_md ?? ""}
          model={typeof event.payload.model === "string" ? event.payload.model : undefined}
        />
      );
    case "tool_use":
      return <ToolCallCollapsed event={event} />;
    case "summary":
      return (
        <div className="msg-assistant border-dashed">
          <div className="text-xs text-muted-foreground mb-2">Summary</div>
          <div className="text-sm whitespace-pre-wrap">{event.payload.content ?? ""}</div>
        </div>
      );
    case "system":
      return (
        <div className="text-xs text-muted-foreground italic px-2">
          system: {event.payload.kind ?? "unknown"} — {event.payload.content ?? ""}
        </div>
      );
    default:
      return null;
  }
};

const SimpleTranscript = ({ events }: Props) => (
  <div
    data-testid="transcript-list"
    className="transcript-list flex-1 overflow-auto px-4 py-4 space-y-3"
    style={{ maxHeight: "calc(100vh - 56px)" }}
  >
    {events.map((event) => (
      <div key={event.event_uuid}>{renderEvent(event)}</div>
    ))}
  </div>
);

const VirtualizedTranscript = ({ events }: Props) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      data-testid="transcript-list"
      className="transcript-list flex-1 overflow-auto px-4 py-4"
      style={{ maxHeight: "calc(100vh - 56px)" }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virt) => {
          const event = events[virt.index];
          if (!event) return null;
          return (
            <div
              key={event.event_uuid}
              data-index={virt.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virt.start}px)`,
                paddingBottom: 12,
              }}
            >
              {renderEvent(event)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const TranscriptList = ({ events }: Props) => {
  if (events.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground" data-testid="transcript-empty">
        No transcript events.
      </div>
    );
  }
  if (events.length < VIRTUALIZE_THRESHOLD) return <SimpleTranscript events={events} />;
  return <VirtualizedTranscript events={events} />;
};
