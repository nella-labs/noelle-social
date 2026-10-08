import { describe, it, expect } from "vitest";
import { ContentMediaCreateSchema, ContentMediaKindSchema, ContentMediaResolvedSchema, ContentMediaResolveInSchema, parseContentMediaReceipt } from "./media.js";

describe("ContentMediaCreateSchema", () => {
  const orgId = "22222222-2222-4222-8222-222222222222";
  const base = { orgId, mimeType: "image/png", dataBase64: "aGVsbG8=" };

  it("retains the explicit organization of an unbound library upload", () => {
    expect(ContentMediaCreateSchema.parse(base)).toMatchObject({ orgId });
  });

  it("requires an organization or a linked parent", () => {
    expect(ContentMediaCreateSchema.safeParse({ mimeType: "image/png", dataBase64: "aGVsbG8=" }).success).toBe(false);
    expect(ContentMediaCreateSchema.safeParse({ ...base, orgId: undefined, draftId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });

  it("rejects a malformed organization instead of dropping it", () => {
    expect(ContentMediaCreateSchema.safeParse({ ...base, orgId: "wrong" }).success).toBe(false);
  });

  it("defaults kind to image and accepts a minimal upload", () => {
    const parsed = ContentMediaCreateSchema.parse(base);
    expect(parsed.kind).toBe("image");
  });

  it("accepts an optional draft attachment + caption", () => {
    const parsed = ContentMediaCreateSchema.parse({
      ...base,
      kind: "video",
      draftId: "11111111-1111-1111-1111-111111111111",
      caption: "demo clip",
      platform: "x",
    });
    expect(parsed.kind).toBe("video");
    expect(parsed.platform).toBe("x");
  });

  it("rejects an empty body and an oversized payload", () => {
    expect(() => ContentMediaCreateSchema.parse({ mimeType: "image/png", dataBase64: "" })).toThrow();
    expect(() =>
      ContentMediaCreateSchema.parse({ mimeType: "image/png", dataBase64: "a".repeat(15_000_001) }),
    ).toThrow();
  });

  it("rejects a non-uuid draftId", () => {
    expect(() => ContentMediaCreateSchema.parse({ ...base, draftId: "nope" })).toThrow();
  });

  it("kind enum is image|video|other", () => {
    expect(ContentMediaKindSchema.options).toEqual(["image", "video", "other"]);
  });
});


describe("current content media receipts", () => {
  const id = "00000000-0000-4000-8000-000000000031", foreign = "00000000-0000-4000-8000-000000000032";
  it("accepts unavailable omissions and current bounded URLs", () => {
    expect(parseContentMediaReceipt({ media: [] }, [id])).toEqual([]);
    expect(parseContentMediaReceipt({ media: [{ id, url: "/media/fixture.png" }] }, [id])).toHaveLength(1);
  });
  it("rejects substituted or repeated asset receipts", () => {
    expect(() => parseContentMediaReceipt({ media: [{ id: foreign, url: null }] }, [id])).toThrow();
    expect(() => parseContentMediaReceipt({ media: [{ id, url: null }, { id: id.toUpperCase(), url: null }] }, [id])).toThrow();
  });
  it("accepts a full bounded signing receipt under the HTTP decoder byte ceiling", () => {
    const base = "https://storage.googleapis.com/", url = base + "a".repeat(8192 - base.length);
    const receipt = { media: Array.from({ length: 4 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 31).padStart(12, "0")}`, url })) };
    expect(ContentMediaResolvedSchema.safeParse(receipt).success).toBe(true);
    expect(JSON.stringify(receipt).length).toBeLessThan(65_536);
  });
  it("bounds signed URL bytes so a full signing batch fits the HTTP response ceiling", () => {
    const url = `https://storage.googleapis.com/${"a".repeat(8200)}`;
    expect(ContentMediaResolvedSchema.safeParse({ media: [{ id, url }] }).success).toBe(false);
  });
  it.each(["javascript:alert(1)", "data:text/html,content", "https://example.com/\npath"])("rejects non-fetchable receipt link %s", url => {
    expect(ContentMediaResolvedSchema.safeParse({ media: [{ id, url }] }).success).toBe(false);
  });
  it("bounds requested work before any signing", () => {
    expect(ContentMediaResolveInSchema.safeParse({ orgId: foreign, ids: Array(5).fill(id) }).success).toBe(false);
  });
});
