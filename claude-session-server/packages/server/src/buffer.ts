// AI-generated. See PROMPT.md for the prompts and model used.

export interface DrainResult<T> {
  readonly frames: readonly T[];
  readonly truncated: boolean;
}

export interface RingBuffer<T> {
  push(frame: T): void;
  drain(): DrainResult<T>;
  readonly size: number;
}

export const createRingBuffer = <T>(cap: number): RingBuffer<T> => {
  if (cap < 1) throw new RangeError("ring buffer cap must be >= 1");

  let frames: T[] = [];
  let truncated = false;

  const push = (frame: T): void => {
    frames.push(frame);
    if (frames.length > cap) {
      frames.shift();
      truncated = true;
    }
  };

  const drain = (): DrainResult<T> => {
    const result: DrainResult<T> = { frames, truncated };
    frames = [];
    truncated = false;
    return result;
  };

  return {
    push,
    drain,
    get size() {
      return frames.length;
    },
  };
};
