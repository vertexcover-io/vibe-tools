// AI-generated. See PROMPT.md for the prompts and model used.

import { Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FilterChips } from "../components/FilterChips";
import { useSearch } from "../lib/api";
import { formatCost, formatRepo } from "../lib/cn";

export const SearchPage = () => {
  const [params, setParams] = useSearchParams();
  const initialQ = params.get("q") ?? params.get("tag") ?? "";
  const [query, setQuery] = useState(initialQ);

  useEffect(() => {
    setQuery(params.get("q") ?? params.get("tag") ?? "");
  }, [params]);

  const filters =
    query.trim().length > 0
      ? {
          q: query,
          repo: params.get("repo") ?? undefined,
          branch: params.get("branch") ?? undefined,
          agent: params.get("agent") ?? undefined,
          has_pr:
            params.get("has_pr") === "true"
              ? true
              : params.get("has_pr") === "false"
                ? false
                : undefined,
        }
      : null;

  const search = useSearch(filters);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    next.set("q", query);
    next.delete("tag");
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-3xl mx-auto p-4">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Search size={16} className="text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions, summaries, tags…"
          className="flex-1 px-3 py-2 rounded border border-border bg-background text-sm"
        />
        <button type="submit" className="px-3 py-2 rounded bg-foreground text-background text-sm">
          Search
        </button>
      </form>

      <div className="mt-3">
        <FilterChips />
      </div>

      <div className="mt-4 space-y-3" data-testid="search-results">
        {!filters && (
          <div className="text-sm text-muted-foreground">
            Type a query to search across all your sessions.
          </div>
        )}
        {search.isLoading && filters && (
          <div className="text-sm text-muted-foreground">Searching…</div>
        )}
        {search.data && search.data.results.length === 0 && (
          <div className="text-sm text-muted-foreground">No results.</div>
        )}
        {search.data?.results.map((r) => (
          <Link
            key={r.session_id}
            to={`/sessions/${r.session_id}`}
            className="block p-4 rounded-lg border border-border bg-card hover:bg-muted"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-medium text-sm">
                {r.title ?? `Session ${r.session_id.slice(0, 8)}`}
              </h3>
              <span className="text-xs font-mono text-muted-foreground">
                {formatCost(r.total_cost_usd)}
              </span>
            </div>
            {r.summary && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{r.summary}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{formatRepo(r.repo)}</span>
              {r.branch && <span className="font-mono">{r.branch}</span>}
              {r.agent && <span className="font-mono">{r.agent}</span>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};
