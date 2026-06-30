// AI-generated. See PROMPT.md for the prompts and model used.
import { createRingBuffer, type RingBuffer } from "./buffer.ts";
import type { ServerFrame } from "./pi-adapter.ts";

export interface SessionLike {
  dispose(): void;
  readonly isStreaming?: boolean;
}

export type WSLike = object;

export interface SessionEntry {
  readonly id: string;
  readonly session: SessionLike;
  ws: WSLike | null;
  busy: boolean;
  lastTurnAt: number;
  readonly buffer: RingBuffer<ServerFrame>;
}

export class AtCapacityError extends Error {
  constructor(maxHot: number) {
    super(`at_capacity: registry full (max ${maxHot})`);
    this.name = "AtCapacityError";
  }
}

export class SessionBusyError extends Error {
  constructor(id: string) {
    super(`session_busy: ${id} already has an in-flight turn`);
    this.name = "SessionBusyError";
  }
}

export class UnknownSessionError extends Error {
  constructor(id: string) {
    super(`unknown_session: ${id}`);
    this.name = "UnknownSessionError";
  }
}

export interface RegistryOptions {
  readonly maxHot: number;
  readonly idleMs: number;
  readonly bufferCap?: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly maxHot: number;
  private readonly idleMs: number;
  private readonly bufferCap: number;

  constructor(options: RegistryOptions) {
    this.maxHot = options.maxHot;
    this.idleMs = options.idleMs;
    this.bufferCap = options.bufferCap ?? 1000;
  }

  get size(): number {
    return this.entries.size;
  }

  add(id: string, session: SessionLike, ws: WSLike | null): SessionEntry {
    if (this.entries.size >= this.maxHot) throw new AtCapacityError(this.maxHot);
    const entry: SessionEntry = {
      id,
      session,
      ws,
      busy: false,
      lastTurnAt: 0,
      buffer: createRingBuffer<ServerFrame>(this.bufferCap),
    };
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  private require(id: string): SessionEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new UnknownSessionError(id);
    return entry;
  }

  markBusy(id: string): void {
    const entry = this.require(id);
    if (entry.busy) throw new SessionBusyError(id);
    entry.busy = true;
  }

  clearBusy(id: string, now: number): void {
    const entry = this.require(id);
    entry.busy = false;
    entry.lastTurnAt = now;
  }

  attach(id: string, ws: WSLike): void {
    this.require(id).ws = ws;
  }

  detach(id: string): void {
    this.require(id).ws = null;
  }

  dispose(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.session.dispose();
    this.entries.delete(id);
  }

  reapIdle(now: number): string[] {
    const disposed: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.busy) continue;
      if (entry.ws !== null) continue;
      if (now - entry.lastTurnAt <= this.idleMs) continue;
      disposed.push(entry.id);
    }
    for (const id of disposed) this.dispose(id);
    return disposed;
  }
}
