// AI-generated. See PROMPT.md for the prompts and model used.

import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { FilterChips } from "../components/FilterChips";
import { SessionCard } from "../components/SessionCard";
import { useRepoSessions } from "../lib/api";
import { formatRepo } from "../lib/cn";

export const RepoView = () => {
  const { canonical } = useParams<{ canonical: string }>();
  const decoded = canonical ? decodeURIComponent(canonical) : "";
  const sessions = useRepoSessions(decoded);

  return (
    <div className="max-w-5xl mx-auto p-4">
      <div className="mb-4">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> All repos
        </Link>
        <h1 className="text-xl font-semibold mt-2">{formatRepo(decoded)}</h1>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">{decoded}</div>
      </div>

      <FilterChips />

      <div className="mt-4 space-y-3" data-testid="repo-sessions">
        {sessions.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {sessions.isError && (
          <div className="text-sm text-red-500">Failed to load sessions for this repo.</div>
        )}
        {sessions.data && sessions.data.sessions.length === 0 && (
          <div className="text-sm text-muted-foreground">No sessions for this repo yet.</div>
        )}
        {sessions.data?.sessions.map((s) => (
          <SessionCard key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
};
