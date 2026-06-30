// AI-generated. See PROMPT.md for the prompts and model used.

export type PromptTask = () => Promise<void>;
export type OnError = (error: unknown) => void;

export interface PromptScheduler {
  schedule(task: PromptTask, onError?: OnError): void;
  idle(): Promise<void>;
}

export const createPromptScheduler = (): PromptScheduler => {
  let tail: Promise<void> = Promise.resolve();

  const schedule = (task: PromptTask, onError?: OnError): void => {
    tail = tail.then(async () => {
      try {
        await task();
      } catch (error) {
        if (onError) onError(error);
      }
    });
  };

  const idle = (): Promise<void> => tail.then(() => undefined);

  return { schedule, idle };
};
