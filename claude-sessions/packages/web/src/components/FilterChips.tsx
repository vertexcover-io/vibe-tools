// AI-generated. See PROMPT.md for the prompts and model used.

import { X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { cn } from "../lib/cn";

const FILTERS = ["repo", "branch", "agent", "model", "has_pr", "date"] as const;
type FilterKey = (typeof FILTERS)[number];

const LABELS: Record<FilterKey, string> = {
  repo: "Repo",
  branch: "Branch",
  agent: "Agent",
  model: "Model",
  has_pr: "Has PR",
  date: "Date",
};

const promptValue = (label: string, current: string): string | null => {
  if (typeof window === "undefined" || typeof window.prompt !== "function") return null;
  const v = window.prompt(`${label}:`, current);
  if (v === null) return null;
  return v.trim();
};

export const FilterChips = () => {
  const [params, setParams] = useSearchParams();

  const setFilter = (key: FilterKey, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const onClick = (key: FilterKey) => {
    if (key === "has_pr") {
      const cur = params.get("has_pr");
      const nxt = cur === "true" ? "false" : cur === "false" ? null : "true";
      setFilter(key, nxt);
      return;
    }
    const v = promptValue(LABELS[key], params.get(key) ?? "");
    if (v === null) return;
    setFilter(key, v.length > 0 ? v : null);
  };

  return (
    <div
      className="filter-chips flex gap-2 flex-wrap py-3 sticky top-0 bg-background border-b border-border z-10"
      data-testid="filter-chips"
    >
      {FILTERS.map((key) => {
        const v = params.get(key);
        const active = v !== null && v !== "";
        return (
          <span
            key={key}
            className={cn(
              "filter-chip inline-flex items-center gap-1 px-3 py-1 text-xs rounded-full border transition-colors",
              active
                ? "bg-foreground text-background border-foreground"
                : "bg-card text-muted-foreground border-border hover:bg-muted",
            )}
          >
            <button
              type="button"
              data-testid={`filter-chip-${key}`}
              onClick={() => onClick(key)}
              className="inline-flex items-center gap-1 cursor-pointer"
            >
              {LABELS[key]}
              {active && <span className="font-mono">: {v}</span>}
            </button>
            {active && (
              <button
                type="button"
                aria-label={`clear ${key}`}
                onClick={() => setFilter(key, null)}
                className="cursor-pointer"
              >
                <X size={12} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};

export const FILTER_KEYS = FILTERS;
