import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGcsMediaStorage } from "./gcs-content-storage.js";

const key = "org/media/a.png", bytes = new Uint8Array([1, 2, 3]);
const receipt = { name: key, bucket: "fixture", size: "3", md5Hash: createHash("md5").update(bytes).digest("base64") };
const options = { bucket: "fixture", getAccessToken: async () => "fixture-token",
  resolveUrl: async () => "https://fixture.invalid/signed" };

describe("GCS media object protocol", () => {
  it("uploads exact bytes with an immutable key and signs only a coherent successful receipt", async () => {
    const resolveUrl = vi.fn(options.resolveUrl);
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/upload/storage/v1/b/fixture/o");
      expect(url.searchParams.get("name")).toBe(key);
      expect(url.searchParams.get("uploadType")).toBe("media");
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
      expect(init?.method).toBe("POST");
      expect(init?.body).toEqual(Buffer.from(bytes));
      return Response.json(receipt);
    });
    const storage = createGcsMediaStorage({ ...options, resolveUrl, fetchImpl });
    expect(await storage.put({ key, bytes, contentType: "image/png" })).toEqual({ url: "https://fixture.invalid/signed" });
    expect(resolveUrl).toHaveBeenCalledExactlyOnceWith(key); expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([{}, { ...receipt, name: "other" }, { ...receipt, bucket: "foreign" },
    { ...receipt, size: "4" }, { ...receipt, md5Hash: "incorrect" }])("rejects an incoherent object receipt before signing: %j", async value => {
      const resolveUrl = vi.fn(options.resolveUrl);
      const storage = createGcsMediaStorage({ ...options, resolveUrl, fetchImpl: async () => Response.json(value) });
      await expect(storage.put({ key, bytes, contentType: "image/png" })).rejects.toThrow(/invalid object receipt/);
      expect(resolveUrl).not.toHaveBeenCalled();
    });

  it("treats an already absent object as an idempotent deletion and escapes the complete key", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/storage/v1/b/fixture/o/org%2Fmedia%2Fa.png");
      expect(init?.method).toBe("DELETE"); return new Response(null, { status: 404 });
    });
    await expect(createGcsMediaStorage({ ...options, fetchImpl }).delete(key)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not replay a rejected upload or include its private diagnostic body", async () => {
    const fetchImpl = vi.fn(async () => new Response("private diagnostic", { status: 503 }));
    await expect(createGcsMediaStorage({ ...options, fetchImpl }).put({ key, bytes, contentType: "image/png" }))
      .rejects.toThrow("GCS object upload rejected: 503");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not acknowledge forbidden deletion", async () => {
    await expect(createGcsMediaStorage({ ...options, fetchImpl: async () => new Response(null, { status: 403 }) }).delete(key))
      .rejects.toThrow("GCS object deletion rejected: 403");
  });

  it("does not dispatch object I/O without valid credentials or expose credential errors", async () => {
    const fetchImpl = vi.fn();
    const storage = createGcsMediaStorage({ ...options, fetchImpl, getAccessToken: async () => { throw Error("private credentials"); } });
    await expect(storage.delete(key)).rejects.toThrow("GCS authentication unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
