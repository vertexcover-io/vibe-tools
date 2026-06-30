// AI-generated. See PROMPT.md for the prompts and model used.

import { Clock, DollarSign, GitBranch, GitPullRequest, Sparkles } from "lucide-react";
import { formatCost, formatDuration, formatRepo } from "../../lib/cn";
import type { SessionDetail } from "../../lib/types";

interface Props {
  session: SessionDetail;
}

export const StickyHeader = ({ session }: Props) => {
  const repo = session.repo?.canonical_url ?? null;
  const branch = session.repo?.branch ?? session.branch ?? null;
  const prCount = session.summary?.prs_referenced.length ?? 0;
  const firstPr = session.summary?.prs_referenced[0] ?? null;
  const prNum = firstPr ? firstPr.match(/\/pull\/(\d+)/)?.[1] : null;

  return (
    <header
      className="sticky top-0 z-20 bg-background/90 backdrop-blur border-b border-border px-4 py-2"
      data-testid="sticky-header"
    >
      <div className="flex items-center gap-3 text-sm flex-wrap">
        <span data-testid="hdr-repo" className="font-mono truncate max-w-[40ch]">
          {formatRepo(repo)}
        </span>
        <span className="text-muted-foreground">/</span>
        <span data-testid="hdr-branch" className="font-mono inline-flex items-center gap-1">
          <GitBranch size={14} />
          {branch ?? "-"}
        </span>
        <span data-testid="hdr-pr" className="inline-flex items-center gap-1">
          <GitPullRequest size={14} />
          {prCount > 0 ? (
            <a href={firstPr ?? "#"} target="_blank" rel="noreferrer" className="pr-badge">
              {prNum ? `#${prNum}` : "PR"}
            </a>
          ) : (
            <span className="text-muted-foreground text-xs">no PR</span>
          )}
        </span>
        <span data-testid="hdr-model" className="font-mono inline-flex items-center gap-1">
          <Sparkles size={14} />
          {session.model ?? "-"}
        </span>
        <span data-testid="hdr-duration" className="font-mono inline-flex items-center gap-1">
          <Clock size={14} />
          {session.started_at && session.ended_at
            ? formatDuration(session.started_at, session.ended_at)
            : "-"}
        </span>
        <span data-testid="hdr-cost" className="font-mono inline-flex items-center gap-1">
          <DollarSign size={14} />
          {formatCost(session.total_cost_usd ?? "0")}
        </span>
      </div>
    </header>
  );
};
