import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), org: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/api", () => ({ noelleFetch: mocks.fetch, NoelleApiError: class extends Error {} }));
vi.mock("@/lib/with-rate-limit", () => ({ withRateLimit: (_key: string, _options: unknown, fn: unknown) => fn }));
vi.mock("@/lib/posts-queries", () => ({ getPostThread: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: mocks.org }));
import { uploadMedia } from "./actions";

const orgId = "00000000-0000-4000-8000-000000000001";
const input = { orgSlug: "selected", kind: "image" as const, mimeType: "image/png", dataBase64: "aGVsbG8=" };
const media = { id: "00000000-0000-4000-8000-000000000002", platform: null, kind: "image", mime_type: "image/png",
  storage_key: "fixture.png", url: "https://fixture.invalid/media", width: null, height: null, duration_ms: null,
  bytes: 5, idea_id: null, draft_id: null, caption: null, status: "ready", created_at: "2026-10-06T00:00:00.000Z" };

describe("uploadMedia organization and response", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.org.mockResolvedValue({ id: orgId }); mocks.fetch.mockResolvedValue({ media });
  });
  it("passes the authorized selected organization to the upload route", async () => {
    expect(await uploadMedia(input)).toEqual({ ok: true, media });
    expect(mocks.org).toHaveBeenCalledWith("selected");
    expect(mocks.fetch).toHaveBeenCalledWith("/api/content-media", { method: "POST", body: expect.objectContaining({ orgId }) });
    expect(mocks.revalidate).toHaveBeenCalledWith("/app/selected/content");
  });
  it("refuses a missing organization before sending bytes", async () => {
    mocks.org.mockResolvedValue(null);
    expect(await uploadMedia(input)).toMatchObject({ ok: false, error: { code: "not_found", status: 404 } });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not acknowledge a malformed upload response", async () => {
    mocks.fetch.mockResolvedValue({ media: { id: media.id, url: media.url } });
    await expect(uploadMedia(input)).rejects.toThrow(); expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
