import { SignJWT } from "jose";
import type { Sql } from "postgres";
import { getDb } from "./db.js";
import { loadEnv, type Env } from "./env.js";

// Shared context threaded into every tool handler. It owns the DB client, the
// operator config, org resolution (slug/uuid → org_id, cached), the read-only
// guard, and the optional api-vm delegation channel.

export interface OrgRef {
  orgId: string;
  slug: string;
  name: string;
}

export class NoelleError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoelleContext {
  readonly sql: Sql;
  readonly env: Env;
  private orgCache = new Map<string, OrgRef>();
  private apiTokenCache?: { token: string; expMs: number };

  constructor(sql: Sql, env: Env) {
    this.sql = sql;
    this.env = env;
  }

  static create(): NoelleContext {
    return new NoelleContext(getDb(), loadEnv());
  }

  // The text id recorded as `decided_by` / `created_by` on rows this operator
  // mutates. Falls back to a stable sentinel so audit columns are never null.
  operatorId(): string {
    return this.env.NOELLE_MCP_OPERATOR_SUB ?? "noelle-mcp";
  }

  // Throw if the server is in read-only mode. Every mutation tool calls this
  // before touching data.
  assertWritable(action: string): void {
    if (this.env.NOELLE_MCP_READONLY) {
      throw new NoelleError(
        `Read-only mode (NOELLE_MCP_READONLY is set): refusing to ${action}. Unset NOELLE_MCP_READONLY to enable writes.`,
      );
    }
  }

  // Resolve an org from an explicit arg (slug or uuid) or the configured
  // default. Cached per key. Throws a friendly message when unresolved.
  async resolveOrg(orgArg?: string): Promise<OrgRef> {
    const key = (orgArg ?? this.env.NOELLE_MCP_ORG ?? "").trim();
    if (!key) {
      throw new NoelleError(
        "No org specified and NOELLE_MCP_ORG is not set. Run noelle_list_orgs to see options, then pass `org` (slug or id) or set NOELLE_MCP_ORG.",
      );
    }
    const cached = this.orgCache.get(key);
    if (cached) return cached;

    const rows = UUID_RE.test(key)
      ? await this.sql<Array<{ id: string; slug: string; name: string }>>`
          select id, slug, name from noelle.organizations where id = ${key} limit 1`
      : await this.sql<Array<{ id: string; slug: string; name: string }>>`
          select id, slug, name from noelle.organizations where slug = ${key} limit 1`;

    const row = rows[0];
    if (!row) {
      throw new NoelleError(`Org not found: "${key}". Run noelle_list_orgs to see available orgs.`);
    }
    const ref: OrgRef = { orgId: row.id, slug: row.slug, name: row.name };
    this.orgCache.set(key, ref);
    this.orgCache.set(row.id, ref);
    this.orgCache.set(row.slug, ref);
    return ref;
  }

  // Whether api-vm delegation is available (base URL + a token or a mint secret).
  apiConfigured(): boolean {
    return (
      !!this.env.NOELLE_API_BASE_URL &&
      (!!this.env.NOELLE_MCP_API_TOKEN || !!this.env.NOELLE_SUPABASE_JWT_SECRET)
    );
  }

  // Fetch against api-vm with an operator bearer token. Throws (caught by
  // callers that fall back to direct DB) when not configured or on non-2xx.
  async apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const base = this.env.NOELLE_API_BASE_URL;
    if (!base) {
      throw new NoelleError("api-vm delegation not configured (set NOELLE_API_BASE_URL).");
    }
    const token = await this.apiToken();
    const res = await fetch(new URL(path, base), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new NoelleError(`api-vm ${path} → ${res.status}: ${bodyText.slice(0, 400)}`);
    }
    return (bodyText ? JSON.parse(bodyText) : undefined) as T;
  }

  // A ready token, or a freshly minted operator JWT (HS256 over the Supabase
  // JWT secret). Cached until ~1 min before expiry.
  private async apiToken(): Promise<string> {
    if (this.env.NOELLE_MCP_API_TOKEN) return this.env.NOELLE_MCP_API_TOKEN;
    const now = Date.now();
    if (this.apiTokenCache && this.apiTokenCache.expMs - 60_000 > now) {
      return this.apiTokenCache.token;
    }
    const secret = this.env.NOELLE_SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new NoelleError(
        "No api-vm token: set NOELLE_MCP_API_TOKEN, or NOELLE_SUPABASE_JWT_SECRET + NOELLE_MCP_OPERATOR_SUB to mint one.",
      );
    }
    const sub = this.env.NOELLE_MCP_OPERATOR_SUB;
    if (!sub) {
      throw new NoelleError(
        "Minting an api-vm token requires NOELLE_MCP_OPERATOR_SUB (the Supabase user id to act as).",
      );
    }
    const ttlSec = 3600;
    const token = await new SignJWT({ role: "authenticated", aud: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(new TextEncoder().encode(secret));
    this.apiTokenCache = { token, expMs: now + ttlSec * 1000 };
    return token;
  }
}
