// AI-generated. See PROMPT.md for the prompts and model used.

import { Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { SessionDetail } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  session: SessionDetail;
}

const buildForkCommand = (session: SessionDetail): string => {
  const parts = ["claude-sessions", "fork", session.id];
  if (session.repo?.canonical_url) {
    parts.push("--cwd", `~/work/${session.repo.canonical_url.split("/").slice(-1)[0]}`);
  }
  return parts.join(" ");
};

export const ForkModal = ({ open, onClose, session }: Props) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  if (!open) return null;
  const cmd = buildForkCommand(session);

  const onCopy = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="fork-modal">
      <button
        type="button"
        aria-label="close dialog"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <dialog
        open
        aria-modal="true"
        className="relative bg-card border border-border rounded-lg p-5 w-full max-w-lg mx-4 text-foreground"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Fork this session</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Run this in your terminal to spin up a fresh checkpoint from this session:
        </p>
        <div className="bg-muted rounded p-3 font-mono text-xs flex items-center gap-2">
          <span className="flex-1 truncate">{cmd}</span>
          <button
            type="button"
            onClick={onCopy}
            className={cn(
              "px-2 py-1 rounded text-xs flex items-center gap-1",
              copied ? "bg-green-500/10 text-green-600" : "bg-card border border-border",
            )}
          >
            <Copy size={12} />
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </dialog>
    </div>
  );
};
