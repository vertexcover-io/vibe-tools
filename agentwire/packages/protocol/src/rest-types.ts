// AI-generated. See PROMPT.md for the prompts and model used.
export interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
  readonly messageCount: number;
}

export interface CompleteOk {
  readonly session_id: string;
  readonly text: string;
  readonly usage: unknown;
}

export interface CompleteErr {
  readonly session_id: string;
  readonly text: string;
  readonly error: { readonly type: string; readonly message: string };
}

export type CompleteResult = CompleteOk | CompleteErr;

export interface ListResult {
  readonly sessions: readonly SessionMeta[];
  readonly nextCursor: string | null;
}

export type ForkResult = { readonly session_id: string } | "invalid_fork_point";
