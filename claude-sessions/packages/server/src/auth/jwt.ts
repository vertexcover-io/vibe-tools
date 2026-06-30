// AI-generated. See PROMPT.md for the prompts and model used.

import { SignJWT, jwtVerify } from "jose";

export type TokenAudience = "web" | "cli" | "mcp";

export interface TokenPayload {
  sub: string;
  email: string;
  role: "user" | "admin";
  aud: TokenAudience;
}

const ISSUER = "claude-sessions";
const ALG = "HS256";

const secretBytes = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signToken = async (
  payload: TokenPayload,
  secret: string,
  expiresIn = "7d",
): Promise<string> => {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuer(ISSUER)
    .setAudience(payload.aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretBytes(secret));
};

export const verifyToken = async (token: string, secret: string): Promise<TokenPayload> => {
  const { payload } = await jwtVerify(token, secretBytes(secret), {
    issuer: ISSUER,
  });
  if (typeof payload.sub !== "string") throw new Error("missing sub");
  if (typeof payload.email !== "string") throw new Error("missing email");
  if (payload.role !== "user" && payload.role !== "admin") throw new Error("bad role");
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (aud !== "web" && aud !== "cli" && aud !== "mcp") throw new Error("bad aud");
  return { sub: payload.sub, email: payload.email, role: payload.role, aud };
};
