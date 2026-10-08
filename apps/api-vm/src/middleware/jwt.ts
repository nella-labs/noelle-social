import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { loadEnv } from "../env.js";

// Verifies a Supabase Auth JWT presented as `Authorization: Bearer <token>`.
// On success the decoded payload is stashed at c.get('auth') for handlers.
//
// Verification path: prefer JWKS (NOELLE_SUPABASE_JWKS_URL) since Supabase
// rotates keys; fall back to symmetric JWT secret (legacy projects) when the
// JWKS URL is not configured.

export type AuthContext = {
  userId: string;
  email?: string;
  raw: JWTPayload;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks(url: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(url));
  return jwks;
}

export const requireUserJwt: MiddlewareHandler<{
  Variables: { auth: AuthContext };
}> = async (c, next) => {
  const env = loadEnv();
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  const token = header.slice("bearer ".length).trim();

  try {
    let payload: JWTPayload;
    if (env.NOELLE_SUPABASE_JWKS_URL) {
      const result = await jwtVerify(token, getJwks(env.NOELLE_SUPABASE_JWKS_URL));
      payload = result.payload;
    } else if (env.NOELLE_SUPABASE_JWT_SECRET) {
      const result = await jwtVerify(
        token,
        new TextEncoder().encode(env.NOELLE_SUPABASE_JWT_SECRET)
      );
      payload = result.payload;
    } else {
      return c.json({ error: "jwt_verification_not_configured" }, 500);
    }

    if (!payload.sub) return c.json({ error: "jwt_missing_sub" }, 401);
    c.set("auth", {
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      raw: payload,
    });
    await next();
  } catch {
    return c.json({ error: "invalid_jwt" }, 401);
  }
};
