// AI-generated. See PROMPT.md for the prompts and model used.

import { Clock, GitBranch, MessageSquare } from "lucide-react";
import { Link } from "react-router-dom";
import { formatCost, formatDuration, formatRepo } from "../lib/cn";
import type { SessionListItem } from "../lib/types";

export const SessionCard = ({ session }: { session: SessionListItem }) => {
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="session-card block p-4 rounded-lg border border-border bg-card hover:bg-muted transition-colors"
      data-testid="session-card"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-sm truncate flex-1">{session.display_name}</h3>
        <span className="text-xs font-mono text-muted-foreground shrink-0">
          {formatCost(session.total_cost_usd)}
        </span>
      </div>
      {session.summary && (
        <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{session.summary}</p>
      )}
      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        {session.repo && (
          <span className="flex items-center gap-1">
            <MessageSquare size={12} />
            {formatRepo(session.repo)}
          </span>
        )}
        {session.branch && (
          <span className="flex items-center gap-1 font-mono">
            <GitBranch size={12} />
            {session.branch}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {formatDuration(session.started_at, session.ended_at)}
        </span>
        {session.model && <span className="font-mono">{session.model}</span>}
      </div>
      {session.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {session.tags.slice(0, 4).map((t) => (
            <span key={t} className="tag-chip pointer-events-none">
              {t}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
};
