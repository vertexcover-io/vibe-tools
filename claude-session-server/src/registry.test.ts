import { describe, it, expect, vi } from "vitest";
import {
  SessionRegistry,
  AtCapacityError,
  SessionBusyError,
  type SessionLike,
} from "./registry.ts";

const mockSession = (): SessionLike & { dispose: ReturnType<typeof vi.fn> } => ({
  dispose: vi.fn(),
});

const ws = (): object => ({});

describe("SessionRegistry", () => {
  it("test_REQ_020_at_capacity_rejects: add beyond maxHot throws AtCapacityError, existing unaffected", () => {
    const reg = new SessionRegistry({ maxHot: 2, idleMs: 1000 });
    reg.add("a", mockSession(), ws());
    reg.add("b", mockSession(), ws());

    expect(() => reg.add("c", mockSession(), ws())).toThrow(AtCapacityError);
    expect(reg.get("a")).toBeDefined();
    expect(reg.get("b")).toBeDefined();
    expect(reg.get("c")).toBeUndefined();
  });

  it("test_REQ_019_single_writer_rejects_concurrent: markBusy twice throws SessionBusyError, first turn unaffected", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    reg.add("a", mockSession(), ws());

    reg.markBusy("a");
    expect(() => reg.markBusy("a")).toThrow(SessionBusyError);
    expect(reg.get("a")?.busy).toBe(true);
  });

  it("clearBusy releases the writer lock and records lastTurnAt", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    reg.add("a", mockSession(), ws());

    reg.markBusy("a");
    reg.clearBusy("a", 5000);
    expect(reg.get("a")?.busy).toBe(false);
    expect(reg.get("a")?.lastTurnAt).toBe(5000);

    expect(() => reg.markBusy("a")).not.toThrow();
  });

  it("detach sets ws=null without disposing; attach restores ws", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    const session = mockSession();
    reg.add("a", session, ws());

    reg.detach("a");
    expect(reg.get("a")?.ws).toBeNull();
    expect(session.dispose).not.toHaveBeenCalled();

    const socket = ws();
    reg.attach("a", socket);
    expect(reg.get("a")?.ws).toBe(socket);
  });

  it("dispose calls session.dispose and removes the entry", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    const session = mockSession();
    reg.add("a", session, ws());

    reg.dispose("a");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(reg.get("a")).toBeUndefined();
  });

  it("test_REQ_018_idle_reaper_disposes_after_window: reaps detached-idle past window", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    const stale = mockSession();
    reg.add("stale", stale, ws());
    reg.clearBusy("stale", 0);
    reg.detach("stale");

    const disposed = reg.reapIdle(2000);
    expect(disposed).toEqual(["stale"]);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(reg.get("stale")).toBeUndefined();
  });

  it("test_EDGE_006_reaper_skips_running: never reaps a busy entry, even if detached and old", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });
    const busy = mockSession();
    reg.add("busy", busy, ws());
    reg.markBusy("busy");
    reg.detach("busy");

    const disposed = reg.reapIdle(1_000_000);
    expect(disposed).toEqual([]);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(reg.get("busy")).toBeDefined();
  });

  it("reaper skips attached sessions and those within the idle window", () => {
    const reg = new SessionRegistry({ maxHot: 5, idleMs: 1000 });

    const attached = mockSession();
    reg.add("attached", attached, ws());
    reg.clearBusy("attached", 0);

    const recent = mockSession();
    reg.add("recent", recent, ws());
    reg.clearBusy("recent", 500);
    reg.detach("recent");

    const disposed = reg.reapIdle(1000);
    expect(disposed).toEqual([]);
    expect(attached.dispose).not.toHaveBeenCalled();
    expect(recent.dispose).not.toHaveBeenCalled();
  });
});
