// AI-generated. See PROMPT.md for the prompts and model used.

export const cn = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(" ");

export const formatDuration = (startedAt: string, endedAt: string): string => {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
};

export const formatCost = (raw: string | number | null | undefined): string => {
  if (raw === null || raw === undefined) return "$0.00";
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
};

export const formatRepo = (canonical: string | null | undefined): string => {
  if (!canonical) return "(no repo)";
  // canonical is like "github.com/owner/repo"
  const parts = canonical.split("/");
  if (parts.length >= 3) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return canonical;
};
