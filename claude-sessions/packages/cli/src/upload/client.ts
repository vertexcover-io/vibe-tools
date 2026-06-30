// AI-generated. See PROMPT.md for the prompts and model used.

import { retryWithBackoff } from "./retry.js";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

export interface IngestSessionMeta {
  id: string;
  agent: "claude-code";
  agent_version: string;
  repo: { canonical_url: string; branch: string | null };
  source_cwd_hint: string;
  started_at: string;
  ended_at: string;
  model: string | null;
  permission_mode: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export interface IngestEvent {
  event_uuid: string;
  parent_uuid: string | null;
  ts: string;
  type: "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";
  payload: unknown;
}

export interface IngestPayload {
  session: IngestSessionMeta;
  events: IngestEvent[];
}

export interface UploadClientOptions {
  serverUrl: string;
  token: string;
  /** Inject undici MockAgent's `fetch` from tests; defaults to global. */
  fetchImpl?: typeof fetch;
  /** Override retry delays; tests pass `[]` to fail fast. */
  retryDelaysMs?: readonly number[];
}

/**
 * Thin wrapper around `fetch` that adds bearer auth, retry-with-backoff,
 * and translates 4xx/5xx into typed errors. The watcher's debouncer calls
 * `ingest()` for each batch; on success the watcher advances its persisted
 * byte offset (REQ-045).
 */
export class UploadClient {
  private serverUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private retryDelaysMs: readonly number[] | undefined;

  constructor(opts: UploadClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelaysMs = opts.retryDelaysMs;
  }

  private async request(path: string, body: unknown, method = "POST"): Promise<unknown> {
    const res = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 4xx is fatal — auth or RBAC won't fix itself with a retry.
      // 5xx is retryable (network/server hiccup).
      throw new HttpError(res.status, text || res.statusText);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * POST /api/sessions/:id/summary — body is the canonical SessionSummary
   * shape. Server generates the embedding inline (REQ-038), so this call
   * does not return until both rows are committed.
   */
  async uploadSummary(sessionId: string, summary: unknown): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/summary`, summary);
  }

  /**
   * PUT /api/sessions/:id/blob — raw NDJSON bytes. Used after the
   * summary upload so a search hit can deep-link to the full transcript
   * (REQ-061).
   */
  async uploadBlob(sessionId: string, bytes: Uint8Array | Buffer): Promise<void> {
    const body =
      bytes instanceof Buffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes;
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/blob`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/x-ndjson",
          authorization: `Bearer ${this.token}`,
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text || res.statusText);
    }
  }

  async ingest(
    payload: IngestPayload,
  ): Promise<{ accepted_events: number; skipped_duplicates: number }> {
    // 4xx is non-retryable: auth/RBAC errors won't heal on their own. Server
    // returns 5xx for transient failures — those flow through retryWithBackoff.
    return (await retryWithBackoff(
      async () =>
        (await this.request("/api/ingest", payload)) as {
          accepted_events: number;
          skipped_duplicates: number;
        },
      {
        ...(this.retryDelaysMs !== undefined ? { delaysMs: this.retryDelaysMs } : {}),
        shouldRetry: (err) => !(err instanceof HttpError && err.status >= 400 && err.status < 500),
      },
    )) as { accepted_events: number; skipped_duplicates: number };
  }

  async enableRepo(canonicalUrl: string, localPath: string): Promise<void> {
    await this.request("/api/repos/enable", {
      canonical_url: canonicalUrl,
      local_path: localPath,
    });
  }

  async disableRepo(canonicalUrl: string, purge: boolean): Promise<void> {
    await this.request("/api/repos/disable", {
      canonical_url: canonicalUrl,
      purge,
    });
  }

  /**
   * GET /api/sessions/:id — full session metadata (used by `fork` to
   * resolve the source repo and by `name`/UI to render display_name).
   */
  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text || res.statusText);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  /**
   * GET /api/sessions/:id/blob — raw NDJSON bytes used by `fork` to
   * reconstruct a resumable transcript locally.
   */
  async getBlobBytes(sessionId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/blob`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text || res.statusText);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * PATCH /api/sessions/:id — set/clear name or flip is_private.
   */
  async patchSession(
    sessionId: string,
    body: { name?: string | null; is_private?: boolean },
  ): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, body, "PATCH");
  }
}
