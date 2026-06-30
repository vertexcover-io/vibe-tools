// AI-generated. See PROMPT.md for the prompts and model used.

import { Folder } from "lucide-react";
import { Link } from "react-router-dom";
import { formatRepo } from "../lib/cn";
import type { RepoSummary } from "../lib/types";

const formatRelative = (iso: string | null): string => {
  if (!iso) return "no activity";
  const d = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - d);
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

export const RepoTile = ({ repo }: { repo: RepoSummary }) => {
  return (
    <Link
      to={`/repos/${encodeURIComponent(repo.canonical_url)}`}
      className="repo-tile block p-4 rounded-lg border border-border bg-card hover:bg-muted transition-colors"
      data-testid="repo-tile"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Folder size={16} className="text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{formatRepo(repo.canonical_url)}</span>
        </div>
        <span className="text-xs font-mono text-muted-foreground shrink-0">
          {repo.session_count}
        </span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground truncate">{repo.canonical_url}</div>
      <div className="mt-3 text-xs text-muted-foreground">{formatRelative(repo.last_activity)}</div>
    </Link>
  );
};
