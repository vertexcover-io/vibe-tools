// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./argon.js";

describe("argon password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("returns false on malformed digest instead of throwing", async () => {
    expect(await verifyPassword("hunter2", "not-a-real-hash")).toBe(false);
  });
});
