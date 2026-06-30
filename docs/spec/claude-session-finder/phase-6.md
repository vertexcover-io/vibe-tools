# Phase 6: Web UI (repo-first home + transcript view)

> **Status:** pending
> **Depends on:** Phase 5
> **Traces to:** REQ-020, REQ-021, REQ-023, REQ-024, REQ-025

## Overview

Vite + React + Tailwind + shadcn/ui SPA, served by the same Hono process at `/`. Three primary screens:

1. **Login** — email + password
2. **Home** — repo-first grid (REQ-023): tile per enabled repo with session count, last activity
3. **Repo view** — list of sessions in that repo with filter chips (REQ-025)
4. **Session view** — sticky header + expandable summary panel + Claude.ai-style transcript (REQ-024)

## Files (sketch)

```
packages/web/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx                       # router
│   ├── lib/
│   │   ├── api.ts                    # fetch wrapper, TanStack Query hooks
│   │   └── auth.ts
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Home.tsx                  # repo grid
│   │   ├── RepoView.tsx              # session list + filters
│   │   ├── SessionView.tsx           # sticky header + summary panel + transcript
│   │   └── Search.tsx                # /search?q= results
│   ├── components/
│   │   ├── RepoTile.tsx
│   │   ├── SessionCard.tsx
│   │   ├── FilterChips.tsx
│   │   ├── transcript/
│   │   │   ├── StickyHeader.tsx      # repo, branch, PR badge, model, duration, cost
│   │   │   ├── SummaryPanel.tsx      # title, summary paragraph, tag chips, files, prs
│   │   │   ├── UserMessage.tsx
│   │   │   ├── AssistantMessage.tsx
│   │   │   ├── ToolCallCollapsed.tsx
│   │   │   └── TranscriptList.tsx    # virtualized for long sessions
│   │   └── ui/                        # shadcn primitives
└── index.html
```

## Layout — Session view (REQ-024)

```
┌──────────────────────────────────────────────────────────────────┐
│ Sticky Header                                                    │
│ vibe-tools / master  •  PR #5  •  sonnet  •  7m 23s  •  $0.21    │
├──────────────────────────────────────────────────────────────────┤
│ Summary panel (open by default; collapses on click)              │
│ Build pin: CLI bookmark manager with Claude NLP add and search   │
│                                                                   │
│ Designed and shipped pin, a Python CLI bookmark manager that uses│
│ the Claude Code CLI for natural-language adds and intent-based   │
│ search. Followed the conventions established by the existing     │
│ aibash tool ... committed as 90a53cf and pushed to master.       │
│                                                                   │
│ Tags: [cli-tooling] [bookmark-manager] [claude-cli] [shipped]    │
│ Files: pin/pin.py · pin/README.md · pin/PROMPT.md                │
│ PRs: (none)                                                      │
├──────────────────────────────────────────────────────────────────┤
│ 👤 You                                                           │
│ Help me create a cli based bookmarking tool ...                  │
│                                                                   │
│ 🤖 Claude (sonnet)                                               │
│ I'll explore the repo conventions and design the tool.           │
│ ▸ Bash: ls /Users/vertexcover/Projects/vibe-tools/   →  5 lines  │
│ ▸ Read: aibash.py                                    →  324 lines│
│                                                                   │
│ Got it. Let me design ...                                        │
│  ...                                                              │
└──────────────────────────────────────────────────────────────────┘
```

## Component sketches

```tsx
// SummaryPanel.tsx
export function SummaryPanel({ session, summary }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <section className="session-summary-panel border-b">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-4 hover:bg-muted">
        <h2 className="text-lg font-semibold truncate">{session.name ?? summary.title}</h2>
        <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{summary.summary}</p>
          <div className="flex flex-wrap gap-1">
            {summary.tags.map(t =>
              <button key={t} className="tag-chip" onClick={() => navigate(`/search?tag=${encodeURIComponent(t)}`)}>
                {t}
              </button>
            )}
          </div>
          {summary.files_touched.length > 0 && (
            <details>
              <summary className="text-xs font-mono cursor-pointer">{summary.files_touched.length} files</summary>
              <ul className="text-xs font-mono mt-1">{summary.files_touched.map(f => <li key={f}>{f}</li>)}</ul>
            </details>
          )}
          {summary.prs_referenced.length > 0 && (
            <div className="flex gap-2">{summary.prs_referenced.map(p =>
              <a key={p} href={p} target="_blank" className="pr-badge">{p.match(/\/pull\/(\d+)/)?.[1] ? `#${p.match(/\/pull\/(\d+)/)?.[1]}` : "PR"}</a>
            )}</div>
          )}
        </div>
      )}
    </section>
  );
}

// ToolCallCollapsed.tsx
export function ToolCallCollapsed({ event }: { event: ToolUseEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-call collapsed border rounded my-2">
      <button onClick={() => setOpen(!open)} className="w-full text-left p-2 font-mono text-sm">
        <ChevronRight className={cn("inline transition-transform", open && "rotate-90")} />
        <span className="font-semibold ml-1">{event.tool}</span>
        <span className="text-muted-foreground ml-2 truncate">{event.input_summary}</span>
      </button>
      {open && (
        <div className="border-t p-2 font-mono text-xs whitespace-pre-wrap bg-muted">
          <div><span className="text-muted-foreground">in:</span> {event.input_summary}</div>
          {event.output_summary && <div><span className="text-muted-foreground">out:</span> {event.output_summary}</div>}
        </div>
      )}
    </div>
  );
}

// TranscriptList.tsx — virtualized via @tanstack/react-virtual
export function TranscriptList({ events }: { events: CanonicalEvent[] }) {
  // ... virtualized renderer that groups consecutive tool_use under their parent assistant_msg
}
```

## Markdown rendering

`react-markdown` + `remark-gfm` for tables/strikethrough + `rehype-shiki` for code highlighting. Shiki uses Claude Code's color palette where possible.

## Filter chips (REQ-025)

```tsx
// FilterChips.tsx
const filters = ["repo", "branch", "agent", "model", "has_pr", "date"] as const;

export function FilterChips({ value, onChange }: Props) {
  return (
    <div className="flex gap-2 flex-wrap py-3 sticky top-14 bg-background border-b">
      {filters.map(f => (
        <FilterPopover key={f} kind={f} value={value[f]} onChange={(v) => onChange({ ...value, [f]: v })} />
      ))}
    </div>
  );
}
```

URL state via TanStack Router or `useSearchParams`. Each filter mirrors a query param.

## Tests

- **REQ-023**: visit `/`, see N tiles for N enabled repos with correct counts
- **REQ-024**: visit `/session/<id>` for a fixture; assert structural classes `.msg-user`, `.msg-assistant`, `.tool-call.collapsed`, `.session-summary-panel`, sticky header with all 6 spans
- **REQ-025**: 6 filter chips render; selecting each updates the URL

E2E with Playwright covers the full flow: login → home → click repo → click session → see transcript.

## Done When

- [ ] All listed tests pass
- [ ] Manually: log in, navigate, see real ingested sessions rendered with full transcript + summary panel
- [ ] Lighthouse perf score ≥ 90 on session view (virtualization, code-split markdown)

## Commit

`feat(web): home + repo + session views with Claude.ai-style transcript (phase 6)`
