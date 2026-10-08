import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isLocalAuth, localOperator } from "./local-auth";

import { authSessionCookieName } from "./auth-session-config";
const VERIFICATION_TIMEOUT_MS = 5_000;
export const MAX_AUTH_COOKIE_BYTES = 32_768;
export function isAuthSessionCookieName(name: string): boolean {
  const prefix = authSessionCookieName();
  return name.length <= 64 && (name === prefix || (name.startsWith(prefix + ".") && /^\d+$/.test(name.slice(prefix.length + 1))));
}

export interface CookieUser {
  id: string;
  email?: string;
  user_metadata?: { full_name?: string; [k: string]: unknown };
  app_metadata?: { provider?: string; [k: string]: unknown };
}

// Next supplies a distinct cookie jar for each request. Weak keys let repeated
// reads share verification without retaining identities across requests.
const requestIdentities = new WeakMap<object, Promise<CookieUser | null>>();

/** Cookie values are unverified; this decoder never establishes an identity. */
export function readAuthSessionCookie(all: { name: string; value: string }[]): {
  cookies: { name: string; value: string }[]; value: unknown; canonical: boolean;
} | null {
  const AUTH_COOKIE_NAME = authSessionCookieName();
  const chunks = all
    .filter((c) => isAuthSessionCookieName(c.name))
    .sort((a, b) => {
      const index = (name: string) =>
        name === AUTH_COOKIE_NAME ? -1 : Number(name.slice(AUTH_COOKIE_NAME.length + 1));
      return index(a.name) - index(b.name);
    }).map(({ name, value }) => ({ name, value }));
  if (!chunks.length || chunks.length > 32) return null;
  let raw = chunks.map((c) => c.value).join("");
  if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_COOKIE_BYTES) return null;
  const canonical = chunks.length === 1 && chunks[0]!.name === AUTH_COOKIE_NAME ||
    chunks.every((chunk, i) => chunk.name === `${AUTH_COOKIE_NAME}.${i}`);
  try {
    if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64url").toString("utf8");
    return { cookies: chunks, value: JSON.parse(raw) as unknown, canonical };
  } catch {
    return { cookies: chunks, value: null, canonical: false };
  }
}

function accessToken(all: { name: string; value: string }[]): string | null {
  try {
    const parsed = readAuthSessionCookie(all)?.value;
    const token: unknown = Array.isArray(parsed)
      ? parsed[0]
      : parsed && typeof parsed === "object" && "access_token" in parsed
        ? parsed.access_token
        : null;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function verifyToken(token: string): Promise<CookieUser | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, VERIFICATION_TIMEOUT_MS);
  });
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return null;
    // Passing an explicit token avoids SSR session initialization/refresh locks.
    // getClaims verifies asymmetric signatures using JWKS; legacy HS tokens are
    // checked by the configured Auth server through its explicit-token getUser.
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([controller.signal, init.signal])
              : controller.signal,
          }),
      },
    });
    const verified = client.auth.getClaims(token).then(({ data, error }): CookieUser | null => {
      const claims = data?.claims;
      if (
        error ||
        !claims ||
        typeof claims.sub !== "string" ||
        !claims.sub.trim() ||
        claims.iss !== `${url}/auth/v1` ||
        !(
          claims.aud === "authenticated" ||
          (Array.isArray(claims.aud) && claims.aud.includes("authenticated"))
        ) ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1000
      )
        return null;
      return {
        id: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        user_metadata: metadata(claims.user_metadata),
        app_metadata: metadata(claims.app_metadata),
      };
    });
    return await Promise.race([verified, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve only a verified Supabase identity or the configured local operator. */
export async function getUserFromCookies(): Promise<CookieUser | null> {
  if (isLocalAuth()) return localOperator();
  const jar = await cookies();
  let identity = requestIdentities.get(jar);
  if (!identity) {
    const token = accessToken(jar.getAll());
    identity = token ? verifyToken(token) : Promise.resolve(null);
    requestIdentities.set(jar, identity);
  }
  return identity;
}
