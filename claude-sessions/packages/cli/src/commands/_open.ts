// AI-generated. See PROMPT.md for the prompts and model used.

import { spawn } from "node:child_process";

/**
 * Cross-platform "open URL in default browser". macOS uses `open`, Linux uses
 * `xdg-open`, Windows uses `cmd /c start`. Returns immediately after spawning
 * — we don't wait for the GUI to come up.
 */
export type Opener = (url: string) => Promise<void>;

export const defaultOpener: Opener = async (url: string): Promise<void> => {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
