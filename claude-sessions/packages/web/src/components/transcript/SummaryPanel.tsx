// AI-generated. See PROMPT.md for the prompts and model used.

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import type { SessionDetail, SessionSummaryPayload } from "../../lib/types";

interface Props {
  session: SessionDetail;
  summary: SessionSummaryPayload;
}

export const SummaryPanel = ({ session, summary }: Props) => {
  const [open, setOpen] = useState(true);
  const title = session.name ?? summary.title ?? session.display_name;

  return (
    <section className="session-summary-panel border-b border-border" data-testid="summary-panel">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted text-left"
        data-testid="summary-toggle"
      >
        <h2 className="text-lg font-semibold truncate">{title}</h2>
        <ChevronDown
          size={18}
          className={cn(
            "transition-transform shrink-0 text-muted-foreground",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3" data-testid="summary-body">
          {summary.summary && (
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
              {summary.summary}
            </p>
          )}
          {summary.tags.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="summary-tags">
              {summary.tags.map((t) => (
                <Link key={t} to={`/search?tag=${encodeURIComponent(t)}`} className="tag-chip">
                  {t}
                </Link>
              ))}
            </div>
          )}
          {summary.files_touched.length > 0 && (
            <details data-testid="summary-files">
              <summary className="text-xs font-mono cursor-pointer text-muted-foreground">
                {summary.files_touched.length} files
              </summary>
              <ul className="text-xs font-mono mt-1 space-y-0.5">
                {summary.files_touched.map((f) => (
                  <li key={f} className="text-muted-foreground">
                    {f}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {summary.prs_referenced.length > 0 && (
            <div className="flex gap-2 flex-wrap" data-testid="summary-prs">
              {summary.prs_referenced.map((p) => {
                const num = p.match(/\/pull\/(\d+)/)?.[1];
                return (
                  <a key={p} href={p} target="_blank" rel="noreferrer" className="pr-badge">
                    {num ? `#${num}` : "PR"}
                  </a>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
