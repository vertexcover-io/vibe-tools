// AI-generated. See PROMPT.md for the prompts and model used.

import { atomicWriteJson, readJsonOr, withFileLock } from "./atomic.js";
import { statePath } from "./paths.js";

export interface FileState {
  byte_offset: number;
  last_event_uuid: string | null;
  session_id: string | null;
  last_seen_at: string;
}

export interface StateFile {
  version: 1;
  files: Record<string, FileState>;
}

const empty = (): StateFile => ({ version: 1, files: {} });

const readAll = (): StateFile => {
  const raw = readJsonOr<StateFile | null>(statePath(), null);
  if (!raw || raw.version !== 1 || typeof raw.files !== "object" || raw.files === null) {
    return empty();
  }
  return raw;
};

export const getFileState = (path: string): FileState | null => {
  const all = readAll();
  return all.files[path] ?? null;
};

export const setFileState = async (path: string, value: FileState): Promise<void> => {
  await withFileLock(statePath(), () => {
    const all = readAll();
    all.files[path] = value;
    atomicWriteJson(statePath(), all);
  });
};

export const listTrackedFiles = (): Array<{ path: string; state: FileState }> => {
  const all = readAll();
  return Object.entries(all.files).map(([path, state]) => ({ path, state }));
};

export const lastSyncTimestamp = (): string | null => {
  const all = readAll();
  let latest: string | null = null;
  for (const f of Object.values(all.files)) {
    if (!latest || f.last_seen_at > latest) latest = f.last_seen_at;
  }
  return latest;
};
