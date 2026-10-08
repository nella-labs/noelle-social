import { Hono } from "hono";
import { z } from "zod";
import { noelleDb } from "../lib/db.js";
import { isOrgMember } from "../lib/auth.js";
import { mutateXApiCredentials, XApiCredentialsScopeError } from "../lib/x-api-creds-db.js";
import type { AuthContext } from "../middleware/jwt.js";

/**
 * X API connection management (the Connections page). Stores the operator's own
 * OAuth 1.0a creds (Consumer Key/Secret + Access Token/Secret) on the org's
 * x_intern (Vega) instance and flips x_api_write_enabled on. Draft-only agents
 * are never touched. Secrets live in noelle.x_api_tokens (DB), like the Apify
 * connection — never logged.
 */
export const xApi = new Hono<{ Variables: { auth: AuthContext } }>();

const SaveCredsSchema = z.object({
  orgSlug: z.string(),
  consumerKey: z.string().trim().min(1),
  consumerSecret: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
  accessTokenSecret: z.string().trim().min(1),
  handle: z.string().trim().optional(),
});

async function resolveXIntern(sql: ReturnType<typeof noelleDb>, orgSlug: string, userId: string) {
  const [org] = await sql<Array<{ id: string }>>`select id from noelle.organizations where slug = ${orgSlug} limit 1`;
  if (!org) return { error: "org_not_found" as const };
  if (!(await isOrgMember(userId, org.id))) return { error: "not_org_member" as const };
  const [inst] = await sql<Array<{ id: string }>>`
    select id from noelle.agent_instances where org_id = ${org.id} and role = 'x_intern' limit 1
  `;
  if (!inst) return { error: "no_x_intern" as const };
  return { orgId: org.id, instanceId: inst.id };
}

xApi.post("/api/x-api/creds", async (c) => {
  const auth = c.get("auth");
  let p: z.infer<typeof SaveCredsSchema>;
  try {
    p = SaveCredsSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }
  const sql = noelleDb();
  const r = await resolveXIntern(sql, p.orgSlug, auth.userId);
  if ("error" in r) return c.json({ error: r.error }, r.error === "not_org_member" ? 403 : 404);

  try {
    await mutateXApiCredentials(sql, r, p);
  } catch (err) {
    if (err instanceof XApiCredentialsScopeError) return c.json({ error: "x_api_owner_changed" }, 409);
    throw err;
  }
  return c.json({ ok: true, handle: p.handle ?? null }, 200);
});

xApi.delete("/api/x-api/creds", async (c) => {
  const auth = c.get("auth");
  const orgSlug = c.req.query("orgSlug") ?? "";
  const sql = noelleDb();
  const r = await resolveXIntern(sql, orgSlug, auth.userId);
  if ("error" in r) return c.json({ error: r.error }, r.error === "not_org_member" ? 403 : 404);
  try {
    await mutateXApiCredentials(sql, r, null);
  } catch (err) {
    if (err instanceof XApiCredentialsScopeError) return c.json({ error: "x_api_owner_changed" }, 409);
    throw err;
  }
  return c.json({ ok: true }, 200);
});
