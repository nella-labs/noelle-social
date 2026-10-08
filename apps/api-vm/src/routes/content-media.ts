import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  ContentMediaCreateSchema,
  type ContentMediaCreate,
  ContentMediaLinkSchema,
  type ContentMediaLink,
} from "@noelle/contracts";
import { mediaKey, extForMime } from "@noelle/runtime/content-storage";
import { isOrgMember } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { ContentMediaWriteError, resolveMediaBinding, reserveScopedMediaUpload, completeScopedMediaUpload, relinkScopedMedia } from "../lib/content-media-db.js";
import { mediaWriteErrorStatus } from "../lib/content-media-binding.js";
import { abandonMediaUpload, claimMediaDeletion, finishMediaDeletion } from "../lib/content-media-delete.js";
import { loadEnv } from "../env.js";
import { getContentStorage } from "../lib/content-storage.js";
import type { AuthContext } from "../middleware/jwt.js";

// User-facing (JWT) content-media routes. Bytes arrive base64-encoded; we write
// them to the storage backend (local dir on self-host, GCS in prod) and insert
// noelle.content_media. Tenancy is enforced by hand (no RLS).
const contentMedia = new Hono<{ Variables: { auth: AuthContext } }>();

// POST /api/content-media — upload one asset (base64 JSON).
contentMedia.post("/api/content-media", async (c) => {
  const auth = c.get("auth");
  let body: ContentMediaCreate;
  try {
    body = ContentMediaCreateSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();

  let binding;
  try {
    binding = await resolveMediaBinding(sql, {
      orgId: body.orgId, draftId: body.draftId, ideaId: body.ideaId, platform: body.platform,
    });
  } catch (error) {
    if (error instanceof ContentMediaWriteError) return c.json({ error: error.category }, 400);
    throw error;
  }
  const orgId = binding.orgId;

  if (!(await isOrgMember(auth.userId, orgId))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const bytes = Buffer.from(body.dataBase64, "base64");
  if (bytes.length === 0) return c.json({ error: "empty_file" }, 400);

  const env = loadEnv();
  const id = randomUUID();
  const key = mediaKey(orgId, id, extForMime(body.mimeType));
  try {
    await reserveScopedMediaUpload(sql, { id, binding, body, key, bytes: bytes.length });
  } catch (error) {
    if (error instanceof ContentMediaWriteError) return c.json({ error: error.category }, mediaWriteErrorStatus(error));
    console.error("[content-media] upload reservation failed", error instanceof Error ? error.message : String(error));
    return c.json({ error: "content_media_reservation_failed" }, 500);
  }
  try {
    const media = await completeScopedMediaUpload(sql, { id, binding, key,
      put: () => getContentStorage(env).put({ key, bytes, contentType: body.mimeType }) });
    return c.json({ media }, 200);
  } catch (error) {
    try {
      await abandonMediaUpload(sql, id, orgId, key);
      await getContentStorage(env).delete(key);
      await finishMediaDeletion(sql, id, orgId, key);
    } catch (cleanupError) {
      console.error("[content-media] abandoned upload cleanup pending", cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      return c.json({ error: "content_media_cleanup_pending", id,
        detail: "Upload failed. Its file remains recorded for cleanup in the media library." }, 503);
    }
    if (error instanceof ContentMediaWriteError) return c.json({ error: error.category }, mediaWriteErrorStatus(error));
    console.error("[content-media] upload failed", error instanceof Error ? error.message : String(error));
    return c.json({ error: "content_media_upload_failed" }, 500);
  }
});

// PATCH /api/content-media/:id — (re)link an existing asset to a post. Lets the
// operator give a scheduled post an image from the Media library (or a generated
// asset) without re-uploading bytes. Binding to a draft derives that draft's
// idea, so both the composer view (queries by idea_id) and the publish worker
// (queries by draft_id) see it. `null` unlinks.
contentMedia.patch("/api/content-media/:id", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  let body: ContentMediaLink;
  try {
    body = ContentMediaLinkSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const existing = await sql<Array<{ org_id: string; draft_id: string | null; idea_id: string | null }>>`
    select org_id, draft_id, idea_id from noelle.content_media where id = ${id} limit 1
  `;
  const row = existing[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  try {
    const media = await relinkScopedMedia(sql, { id, orgId: row.org_id, body });
    return c.json({ media }, 200);
  } catch (error) {
    if (error instanceof ContentMediaWriteError) return c.json({ error: error.category }, mediaWriteErrorStatus(error));
    console.error("[content-media] link update failed", error instanceof Error ? error.message : String(error));
    return c.json({ error: "content_media_update_failed" }, 500);
  }
});

// DELETE /api/content-media/:id — remove the row + the stored object.
contentMedia.delete("/api/content-media/:id", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const sql = noelleDb();
  const rows = await sql<Array<{ org_id: string; storage_key: string }>>`
    select org_id, storage_key from noelle.content_media where id = ${id} limit 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  let key: string;
  try {
    key = await claimMediaDeletion(sql, id, row.org_id);
  } catch (error) {
    if (error instanceof ContentMediaWriteError) return c.json({ error: error.category }, mediaWriteErrorStatus(error));
    console.error("[content-media] deletion claim failed", error instanceof Error ? error.message : String(error));
    return c.json({ error: "content_media_delete_failed" }, 500);
  }
  try {
    await getContentStorage(loadEnv()).delete(key);
    await finishMediaDeletion(sql, id, row.org_id, key);
  } catch (error) {
    console.error("[content-media] deletion pending", error instanceof Error ? error.message : String(error));
    return c.json({ error: "content_media_delete_pending", detail: "Deletion is pending. Retry to finish removing the file." }, 503);
  }
  return c.json({ id, status: "deleted" }, 200);
});

export { contentMedia };
