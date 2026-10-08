import { cookies } from "next/headers";
import type { CookieOptions } from "@supabase/ssr";
import { MAX_AUTH_COOKIE_BYTES, isAuthSessionCookieName, readAuthSessionCookie } from "../auth-cookie";
import { authSessionCookieName } from "../auth-session-config";
import { ApiSessionError, ApiSessionOwner } from "./api-session-owner";

const owner = new ApiSessionOwner();
const REFRESH_MARGIN_MS = 90_000;
const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
type CookieWrite = { name: string; value: string; options: CookieOptions };
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_AUTH_COOKIE_BYTES && jwtShape.test(value);
}
function freshAccessToken(value: unknown): string | null {
  if (!record(value) || !token(value.access_token) || typeof value.refresh_token !== "string" || !value.refresh_token ||
    typeof value.expires_at !== "number" || !Number.isFinite(value.expires_at) || value.expires_at * 1000 <= Date.now() + REFRESH_MARGIN_MS) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(value.access_token.split(".")[1]!, "base64url").toString("utf8"));
    return record(claims) && typeof claims.exp === "number" && Number.isFinite(claims.exp) &&
      claims.exp * 1000 > Date.now() + REFRESH_MARGIN_MS ? value.access_token : null;
  } catch { return null; }
}
function cookieOptions(value: unknown): value is CookieOptions {
  if (!record(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    if (["secure", "httpOnly", "partitioned"].includes(key)) { if (typeof field !== "boolean") return false; }
    else if (key === "maxAge") { if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) return false; }
    else if (key === "expires") { if (!(field instanceof Date) || !Number.isFinite(field.getTime())) return false; }
    else if (key === "sameSite") { if (typeof field !== "boolean" && !["lax", "strict", "none"].includes(String(field))) return false; }
    else if (key === "priority") { if (!["low", "medium", "high"].includes(String(field))) return false; }
    else if (key === "path" || key === "domain") { if (typeof field !== "string" || field.length > 1024 || /[\r\n\0]/.test(field)) return false; }
    else return false;
  }
  return true;
}
function cookieWrites(value: unknown): CookieWrite[] {
  if (!Array.isArray(value) || value.length > 32) throw new ApiSessionError("invalid_response");
  const seen = new Set<string>(); let bytes = 0;
  return value.map(row => {
    if (!record(row) || typeof row.name !== "string" || !isAuthSessionCookieName(row.name) || seen.has(row.name) ||
      typeof row.value !== "string" || !cookieOptions(row.options)) throw new ApiSessionError("invalid_response");
    bytes += Buffer.byteLength(row.value, "utf8");
    if (bytes > MAX_AUTH_COOKIE_BYTES) throw new ApiSessionError("invalid_response");
    seen.add(row.name);
    return { name: row.name, value: row.value, options: row.options };
  });
}

/** Forward opaque tokens only; the receiving API verifies the JWT and membership. */
export async function getApiSessionAccessToken(timeoutMs = 8_000): Promise<string | null> {
  const jar = await cookies();
  const snapshot = readAuthSessionCookie(jar.getAll());
  if (!snapshot) return null;
  const fresh = snapshot.canonical ? freshAccessToken(snapshot.value) : null;
  if (fresh) return fresh;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new ApiSessionError("unavailable");
  const receipt = await owner.request({ url, anonKey, cookieName: authSessionCookieName(url), cookies: snapshot.cookies }, timeoutMs);
  if (!record(receipt) || !Object.hasOwn(receipt, "accessToken") || receipt.accessToken !== null && !token(receipt.accessToken)) throw new ApiSessionError("invalid_response");
  if (receipt.error === "unavailable") throw new ApiSessionError("unavailable");
  if (receipt.error !== undefined && receipt.error !== "rejected" || receipt.error === "rejected" && receipt.accessToken !== null) throw new ApiSessionError("invalid_response");
  const writes = cookieWrites(receipt.cookies);
  try { for (const row of writes) jar.set(row.name, row.value, row.options); }
  catch { /* Server Component cookie jars are read-only. */ }
  return receipt.accessToken as string | null;
}
