import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.ts";
import {
  sessionFileFor,
  buildPiRestAdapter,
  type SessionInfoLike,
} from "./pi-rest-adapter.ts";

const cfg = loadConfig({ PI_WORKING_DIR: "/work" });

const infos: SessionInfoLike[] = [
  {
    id: "s1",
    path: "/home/.pi/agent/sessions/enc/100_s1.jsonl",
    firstMessage: "first",
    modified: new Date(100),
    messageCount: 2,
  },
  {
    id: "s2",
    path: "/home/.pi/agent/sessions/enc/300_s2.jsonl",
    name: "named",
    firstMessage: "second",
    modified: new Date(300),
    messageCount: 4,
  },
];

const lister = async (cwd: string): Promise<readonly SessionInfoLike[]> => {
  expect(cwd).toBe("/work");
  return infos;
};

describe("pi-rest-adapter", () => {
  it("sessionFileFor resolves the real on-disk path from SessionManager.list, not a constructed path", async () => {
    const file = await sessionFileFor(cfg, "s1", lister);
    expect(file).toBe("/home/.pi/agent/sessions/enc/100_s1.jsonl");
  });

  it("sessionFileFor throws for an unknown id", async () => {
    await expect(sessionFileFor(cfg, "nope", lister)).rejects.toThrow(/not found/);
  });

  it("listSessions returns metadata newest-first with name preferred over firstMessage", async () => {
    const adapter = buildPiRestAdapter(cfg, lister);
    const { sessions, nextCursor } = await adapter.listSessions(50);
    expect(sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(sessions[0]!.title).toBe("named");
    expect(sessions[1]!.title).toBe("first");
    expect(nextCursor).toBeNull();
  });

  it("listSessions paginates and advances the cursor", async () => {
    const adapter = buildPiRestAdapter(cfg, lister);
    const first = await adapter.listSessions(1);
    expect(first.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(first.nextCursor).toBe("s2");
    const second = await adapter.listSessions(1, "s2");
    expect(second.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("loadMessages returns null for an unknown id", async () => {
    const adapter = buildPiRestAdapter(cfg, lister);
    expect(await adapter.loadMessages("nope")).toBeNull();
  });
});
