// AI-generated. See PROMPT.md for the prompts and model used.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

/**
 * Atomic write: serialize, write to a sibling tempfile, fsync, rename over.
 *
 * Rename on POSIX is atomic on the same filesystem; readers either see the
 * old or the new content but never a half-written file. We chmod after
 * write so secret files (credentials.json) get `0600` before any reader
 * could open them.
 */
export const atomicWriteJson = (path: string, value: unknown, mode?: number): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", mode ?? 0o644);
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
};

export const readJsonOr = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/**
 * Wrap a read-modify-write under proper-lockfile so concurrent CLI invocations
 * don't clobber each other. The lock lives next to the target file.
 */
export const withFileLock = async <T>(path: string, fn: () => Promise<T> | T): Promise<T> => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // proper-lockfile requires the target to exist; touch it.
  if (!existsSync(path)) {
    const fd = openSync(path, "a");
    closeSync(fd);
  }
  const release = await lockfile.lock(path, {
    retries: { retries: 30, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
};

export const removeIfEmpty = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
};
