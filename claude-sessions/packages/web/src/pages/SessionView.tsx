// AI-generated. See PROMPT.md for the prompts and model used.

import { ArrowLeft, GitFork } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ForkModal } from "../components/ForkModal";
import { StickyHeader } from "../components/transcript/StickyHeader";
import { SummaryPanel } from "../components/transcript/SummaryPanel";
import { TranscriptList } from "../components/transcript/TranscriptList";
import { useSession, useSessionEvents } from "../lib/api";

export const SessionView = () => {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const events = useSessionEvents(id);
  const [forkOpen, setForkOpen] = useState(false);

  if (session.isLoading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Loading session…</div>;
  }
  if (session.isError || !session.data) {
    return <div className="p-8 text-center text-sm text-red-500">Failed to load session.</div>;
  }
  const data = session.data;

  return (
    <div className="flex flex-col h-full" data-testid="session-view">
      <StickyHeader session={data} />

      <div className="px-4 pt-3">
        <div className="flex items-center justify-between">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={14} /> Home
          </Link>
          <button
            type="button"
            onClick={() => setForkOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted"
            data-testid="fork-button"
          >
            <GitFork size={14} /> Fork
          </button>
        </div>
      </div>

      {data.summary && <SummaryPanel session={data} summary={data.summary} />}

      {events.isLoading && (
        <div className="p-8 text-center text-sm text-muted-foreground">Loading transcript…</div>
      )}
      {events.data && <TranscriptList events={events.data.events} />}

      <ForkModal open={forkOpen} onClose={() => setForkOpen(false)} session={data} />
    </div>
  );
};
