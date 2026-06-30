// AI-generated. See PROMPT.md for the prompts and model used.

import type { SessionSummary } from "@claude-sessions/core";
import { describe, expect, it } from "vitest";
import type { UploadClient } from "../upload/client.js";
import { Summarizer } from "./index.js";

const buildOkSummary = (id: string): SessionSummary => ({
  session_id: id,
  title: "ok",
  summary: "ran fine",
  tags: ["t"],
  files_touched: [],
  prs_referenced: [],
  tool_call_counts: {},
  generated_at: "2026-05-09T10:00:00Z",
  model: "sonnet",
  status: "ok",
});

class FakeUpload implements Pick<UploadClient, "uploadSummary" | "uploadBlob"> {
  uploads: Array<{ id: string; summary: unknown }> = [];
  blobs: Array<{ id: string; size: number }> = [];
  failures = 0;

  uploadSummary = (id: string, summary: unknown): Promise<void> => {
    this.uploads.push({ id, summary });
    return Promise.resolve();
  };
  uploadBlob = (id: string, bytes: Uint8Array | Buffer): Promise<void> => {
    this.blobs.push({ id, size: bytes.byteLength });
    return Promise.resolve();
  };
}

describe("Summarizer (REQ-018, REQ-019)", () => {
  it("REQ-018: 3 throws then a 4th success returns the success result", async () => {
    let attempts = 0;
    const upload = new FakeUpload() as unknown as UploadClient;
    const sum = new Summarizer({
      upload,
      retryDelaysMs: [0, 0, 0],
      runPipeline: () => {
        attempts++;
        if (attempts < 4) return Promise.reject(new Error(`boom-${attempts}`));
        return Promise.resolve(buildOkSummary("s-retry"));
      },
      logger: () => undefined,
    });
    const out = await sum.summarize("s-retry", "/tmp/x.jsonl");
    expect(attempts).toBe(4);
    expect(out.status).toBe("ok");
  });

  it("REQ-018: 4 throws → status=failed marker uploaded", async () => {
    let attempts = 0;
    const upload = new FakeUpload();
    const sum = new Summarizer({
      upload: upload as unknown as UploadClient,
      retryDelaysMs: [0, 0, 0],
      runPipeline: () => {
        attempts++;
        return Promise.reject(new Error(`boom-${attempts}`));
      },
      logger: () => undefined,
    });
    const out = await sum.summarize("s-fail", "/tmp/x.jsonl");
    expect(attempts).toBe(4);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("boom-4");
    expect(upload.uploads).toHaveLength(1);
    const stored = upload.uploads[0]?.summary as SessionSummary;
    expect(stored.status).toBe("failed");
  });

  it("REQ-019: max 2 in-flight when 10 are enqueued", async () => {
    let inflight = 0;
    let peak = 0;
    const upload = new FakeUpload() as unknown as UploadClient;
    const sum = new Summarizer({
      upload,
      maxConcurrent: 2,
      retryDelaysMs: [],
      runPipeline: async (id) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return buildOkSummary(id);
      },
      logger: () => undefined,
    });

    const ids = Array.from({ length: 10 }, (_, i) => `s-${i}`);
    await Promise.all(ids.map((id) => sum.summarize(id, "/tmp/x.jsonl")));
    expect(peak).toBe(2);
    expect(sum.inFlight()).toBe(0);
  });
});
