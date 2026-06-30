// AI-generated. See PROMPT.md for the prompts and model used.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RepoSummary,
  SearchResult,
  SessionDetail,
  SessionListItem,
  TranscriptEvent,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const baseHeaders = (init?: HeadersInit): Headers => {
  const h = new Headers(init);
  h.set("accept", "application/json");
  return h;
};

export const apiFetch = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = baseHeaders(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : null) ??
      `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
};

// ----- Auth ---------------------------------------------------------------

export interface LoginInput {
  email: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  user: User;
}

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
};

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear();
    },
  });
};

export const useMe = () =>
  useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<{ user: User }>("/api/auth/me"),
    retry: false,
    refetchOnWindowFocus: false,
  });

// ----- Repos --------------------------------------------------------------

export const useEnabledRepos = () =>
  useQuery({
    queryKey: ["repos"],
    queryFn: () => apiFetch<{ repos: RepoSummary[] }>("/api/repos"),
  });

export const useRepoSessions = (canonicalUrl: string | undefined) =>
  useQuery({
    queryKey: ["repo-sessions", canonicalUrl],
    enabled: !!canonicalUrl,
    queryFn: () =>
      apiFetch<{ repo: { canonical_url: string } | null; sessions: SessionListItem[] }>(
        `/api/repos/${encodeURIComponent(canonicalUrl ?? "")}/sessions`,
      ),
  });

// ----- Sessions -----------------------------------------------------------

export const useRecentSessions = (
  params: {
    limit?: number;
    agent?: string;
    repo?: string;
    branch?: string;
  } = {},
) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `/api/sessions${qs.toString() ? `?${qs.toString()}` : ""}`;
  return useQuery({
    queryKey: ["recent-sessions", qs.toString()],
    queryFn: () => apiFetch<{ sessions: SessionListItem[] }>(url),
  });
};

export const useSession = (id: string | undefined) =>
  useQuery({
    queryKey: ["session", id],
    enabled: !!id,
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${id}`),
  });

export const useSessionEvents = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-events", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ events: TranscriptEvent[] }>(`/api/sessions/${id}/events`),
  });

// ----- Search -------------------------------------------------------------

export interface SearchFilters {
  q: string;
  repo?: string;
  branch?: string;
  agent?: string;
  has_pr?: boolean;
  since?: string;
  limit?: number;
  tag?: string;
}

export const useSearch = (filters: SearchFilters | null) =>
  useQuery({
    queryKey: ["search", filters],
    enabled: !!filters && filters.q.trim().length > 0,
    queryFn: () => {
      const qs = new URLSearchParams();
      if (!filters) return Promise.resolve({ results: [], strategy: "rrf" as const });
      qs.set("q", filters.q);
      if (filters.repo) qs.set("repo", filters.repo);
      if (filters.branch) qs.set("branch", filters.branch);
      if (filters.agent) qs.set("agent", filters.agent);
      if (filters.has_pr !== undefined) qs.set("has_pr", String(filters.has_pr));
      if (filters.since) qs.set("since", filters.since);
      if (filters.limit) qs.set("limit", String(filters.limit));
      return apiFetch<{ results: SearchResult[]; strategy: "rrf" }>(`/api/search?${qs.toString()}`);
    },
  });
