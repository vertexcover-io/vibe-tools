// AI-generated. See PROMPT.md for the prompts and model used.

import { Link } from "react-router-dom";
import { RepoTile } from "../components/RepoTile";
import { SessionCard } from "../components/SessionCard";
import { useEnabledRepos, useRecentSessions } from "../lib/api";

export const HomePage = () => {
  const repos = useEnabledRepos();
  const recent = useRecentSessions({ limit: 10 });

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-8" data-testid="home-page">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">Repositories</h2>
          <Link to="/search" className="text-xs text-muted-foreground hover:text-foreground">
            Search
          </Link>
        </div>
        {repos.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {repos.isError && <div className="text-sm text-red-500">Failed to load repos</div>}
        {repos.data && repos.data.repos.length === 0 && (
          <div className="text-sm text-muted-foreground bg-card p-4 rounded border border-border">
            No repos enabled. Run <code className="font-mono">claude-sessions login</code> in a
            local checkout to enable one.
          </div>
        )}
        {repos.data && repos.data.repos.length > 0 && (
          <div
            className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="repo-grid"
          >
            {repos.data.repos.map((r) => (
              <RepoTile key={r.id} repo={r} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent sessions</h2>
        {recent.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {recent.data && recent.data.sessions.length === 0 && (
          <div className="text-sm text-muted-foreground">Nothing yet.</div>
        )}
        {recent.data && recent.data.sessions.length > 0 && (
          <div className="space-y-3" data-testid="recent-sessions">
            {recent.data.sessions.map((s) => (
              <SessionCard key={s.id} session={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
