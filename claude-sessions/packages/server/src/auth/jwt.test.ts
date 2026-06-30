// AI-generated. See PROMPT.md for the prompts and model used.

import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./jwt.js";

const SECRET = "test-secret-test-secret-test";

describe("jwt sign/verify", () => {
  it("round-trips a valid token", async () => {
    const token = await signToken(
      { sub: "user-1", email: "a@b.test", role: "user", aud: "cli" },
      SECRET,
    );
    const payload = await verifyToken(token, SECRET);
    expect(payload.sub).toBe("user-1");
    expect(payload.email).toBe("a@b.test");
    expect(payload.role).toBe("user");
    expect(payload.aud).toBe("cli");
  });

  it("rejects tokens signed with the wrong secret", async () => {
    const token = await signToken(
      { sub: "user-1", email: "a@b.test", role: "user", aud: "web" },
      SECRET,
    );
    await expect(verifyToken(token, "different-secret-different")).rejects.toThrow();
  });

  it("rejects tampered tokens", async () => {
    const token = await signToken(
      { sub: "user-1", email: "a@b.test", role: "user", aud: "web" },
      SECRET,
    );
    const tampered = `${token}aa`;
    await expect(verifyToken(tampered, SECRET)).rejects.toThrow();
  });
});
