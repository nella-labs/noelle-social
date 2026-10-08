import { Hono } from "hono";
import { ContentMediaResolveInSchema, ContentMediaWorkerResolveInSchema } from "@noelle/contracts";
import { isOrgMember } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { getContentStorage } from "../lib/content-storage.js";
import { ContentMediaWriteError } from "../lib/content-media-binding.js";
import { resolveMediaReadLinks } from "../lib/content-media-read-db.js";
import { loadEnv } from "../env.js";
import { requireHmac } from "../middleware/hmac.js";
import type { AuthContext } from "../middleware/jwt.js";

const contentMediaRead = new Hono<{ Variables: { auth: AuthContext } }>();
contentMediaRead.post("/api/content-media/resolve", async c => {
  const parsed = ContentMediaResolveInSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  if (!(await isOrgMember(c.get("auth").userId, parsed.data.orgId))) return c.json({ error: "not_org_member" }, 403);
  try { return c.json({ media: await resolveMediaReadLinks(noelleDb(), getContentStorage(loadEnv()), parsed.data) }); }
  catch (error) { return c.json({ error: error instanceof ContentMediaWriteError ? error.category : "content_media_read_failed" }, error instanceof ContentMediaWriteError ? 400 : 503); }
});

// The existing VM HMAC flow authorizes a coherent org/instance read; it never accepts a user JWT here.
const contentMediaWorkerRead = new Hono();
contentMediaWorkerRead.post("/api/content-media/resolve-worker", requireHmac, async c => {
  const parsed = ContentMediaWorkerResolveInSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  try { return c.json({ media: await resolveMediaReadLinks(noelleDb(), getContentStorage(loadEnv()), parsed.data) }); }
  catch (error) { return c.json({ error: error instanceof ContentMediaWriteError ? error.category : "content_media_read_failed" }, error instanceof ContentMediaWriteError ? 400 : 503); }
});
export { contentMediaRead, contentMediaWorkerRead };
