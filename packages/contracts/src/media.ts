import { z } from "zod";
import { UuidSchema, TimestampSchema } from "./common.js";
import { PostPlatformSchema } from "./posts.js";

// Content-media wire shapes (noelle.content_media). Media is uploaded as base64
// JSON — the same shape works for the browser (a server action reads the File)
// and for the CLI/skills bridge, and avoids multipart parsing in the api-vm.
// Bytes flow through the api-vm, which writes them to the storage backend
// (local dir on self-host, per-org GCS in prod) and returns the resolved row.

export const ContentMediaKindSchema = z.enum(["image", "video", "other"]);
export type ContentMediaKind = z.infer<typeof ContentMediaKindSchema>;

export const ContentMediaStatusSchema = z.enum(["uploading", "ready", "failed", "deleting"]);
export type ContentMediaStatus = z.infer<typeof ContentMediaStatusSchema>;

// ~15MB of base64 ≈ ~11MB file — a sane ceiling for post images/short clips.
export const CONTENT_MEDIA_MAX_BASE64_LENGTH = 15_000_000;
export const CONTENT_MEDIA_MAX_BYTES = Math.floor(CONTENT_MEDIA_MAX_BASE64_LENGTH / 4) * 3;

// POST /api/content-media (JWT) — upload one asset.
export const ContentMediaCreateSchema = z.object({
  orgId: UuidSchema.optional(),
  kind: ContentMediaKindSchema.default("image"),
  mimeType: z.string().min(1).max(255),
  // The file bytes, base64-encoded (no data: URI prefix).
  dataBase64: z.string().min(1).max(CONTENT_MEDIA_MAX_BASE64_LENGTH),
  filename: z.string().max(255).optional(),
  caption: z.string().max(2000).nullable().optional(),
  platform: PostPlatformSchema.nullable().optional(),
  ideaId: UuidSchema.nullable().optional(),
  draftId: UuidSchema.nullable().optional(),
  width: z.number().int().nonnegative().nullable().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
}).refine(value => Boolean(value.orgId || value.ideaId || value.draftId), {
  message: "provide orgId or a linked ideaId/draftId",
});
export type ContentMediaCreate = z.infer<typeof ContentMediaCreateSchema>;

// PATCH /api/content-media/:id (JWT) — (re)link an EXISTING asset (a library
// upload or a generated image) to a post, so a scheduled post can be given an
// image without re-uploading the bytes. `draftId` binds it to that draft (the
// api-vm also derives the draft's idea so the composer/publish paths both see
// it); pass `null` to unlink. Providing only `ideaId` links at the idea level.
export const ContentMediaLinkSchema = z
  .object({
    draftId: UuidSchema.nullable().optional(),
    ideaId: UuidSchema.nullable().optional(),
  })
  .refine((v) => v.draftId !== undefined || v.ideaId !== undefined, {
    message: "provide draftId and/or ideaId (null to unlink)",
  });
export type ContentMediaLink = z.infer<typeof ContentMediaLinkSchema>;

// Read model (dashboard server components / queries).
export const ContentMediaViewSchema = z.object({
  id: UuidSchema,
  platform: z.string().nullable(),
  kind: ContentMediaKindSchema,
  mime_type: z.string().nullable(),
  storage_key: z.string(),
  url: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  idea_id: UuidSchema.nullable(),
  draft_id: UuidSchema.nullable(),
  caption: z.string().nullable(),
  status: ContentMediaStatusSchema,
  created_at: TimestampSchema,
});
export type ContentMediaView = z.infer<typeof ContentMediaViewSchema>;

export const ContentMediaCreatedSchema = z.object({
  media: ContentMediaViewSchema,
});
export type ContentMediaCreated = z.infer<typeof ContentMediaCreatedSchema>;

/** Bound one signing batch independently of the media library size. */
export const CONTENT_MEDIA_RESOLVE_MAX_IDS = 4;
export const ContentMediaResolveInSchema = z.object({
  orgId: UuidSchema,
  ids: z.array(UuidSchema).min(1).max(CONTENT_MEDIA_RESOLVE_MAX_IDS),
  agentInstanceId: UuidSchema.optional(),
});
export const ContentMediaWorkerResolveInSchema = ContentMediaResolveInSchema.extend({ agentInstanceId: UuidSchema });
export const CONTENT_MEDIA_READ_URL_MAX_BYTES = 8192;
const HttpContentMediaUrlSchema = z.string().url().regex(/^https?:\/\//i);
export const ContentMediaReadUrlSchema = z.string().min(1).max(CONTENT_MEDIA_READ_URL_MAX_BYTES).refine(value => {
  if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) return false;
  if (value.startsWith("/media/")) return true;
  return HttpContentMediaUrlSchema.safeParse(value).success;
}, { message: "expected a bounded HTTP or local media link" });
export const ContentMediaResolvedSchema = z.object({
  media: z.array(z.object({ id: UuidSchema, url: ContentMediaReadUrlSchema.nullable() })).max(CONTENT_MEDIA_RESOLVE_MAX_IDS),
});

/** A read receipt may omit unavailable assets, but cannot substitute or duplicate requested IDs. */
export function parseContentMediaReceipt(value: unknown, requestedIds: readonly string[]) {
  const received = ContentMediaResolvedSchema.parse(value);
  const requested = new Set(requestedIds.map(id => id.toLowerCase())), seen = new Set<string>();
  for (const row of received.media) {
    const id = row.id.toLowerCase();
    if (!requested.has(id) || seen.has(id)) throw new Error("content media read returned an invalid asset receipt");
    seen.add(id);
  }
  return received.media;
}
