import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

const owner = vi.hoisted(() => ({
  token: vi.fn(), metadata: vi.fn(), sign: vi.fn(), close: vi.fn(), factory: vi.fn(),
}));
vi.mock("@noelle/runtime/google-credentials", () => ({ createGoogleCredentialClient: owner.factory }));
vi.mock("@google-cloud/storage", async importOriginal => {
  const { Storage } = await importOriginal<typeof import("@google-cloud/storage")>();
  return { Storage: class extends Storage {
    constructor() {
      super({ projectId: "fixture" });
      this.authClient.getAccessToken = async () => { throw Error("legacy SDK token discovery"); };
      this.authClient.getCredentials = async () => { throw Error("legacy SDK metadata discovery"); };
      this.authClient.sign = async () => { throw Error("legacy SDK signing"); };
    }
  } };
});
import { getContentStorage, resetContentStorageForTests } from "./content-storage.js";

const env = { NOELLE_MEDIA_BACKEND: "gcs", NOELLE_MEDIA_BUCKET: "fixture-bucket" } as Env;
const key = "fixture-org/media/image.png", bytes = new Uint8Array([1, 2, 3]);
beforeEach(() => {
  owner.token.mockResolvedValue("bounded-token"); owner.metadata.mockResolvedValue({ client_email: "fixture@example.invalid" });
  owner.sign.mockResolvedValue(Buffer.from("signature").toString("base64")); owner.close.mockResolvedValue(undefined);
  owner.factory.mockReturnValue({ getAccessToken: owner.token, getCredentials: owner.metadata, sign: owner.sign, close: owner.close });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: key, bucket: "fixture-bucket", size: "3",
    md5Hash: createHash("md5").update(bytes).digest("base64") })));
});
afterEach(async () => { await resetContentStorageForTests(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("GCS bounded credential composition", () => {
  it("refreshes an old signed link through the actual SDK signer without another object upload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const storage = getContentStorage(env), initial = await storage.put({ key, bytes, contentType: "image/png" });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const current = await storage.resolveUrl!(key);
    expect(new URL(initial.url).searchParams.get("X-Goog-Date")).toBe("20261001T000000Z");
    expect(new URL(current).searchParams.get("X-Goog-Date")).toBe("20261009T000000Z");
    expect(new URL(current).searchParams.get("X-Goog-Expires")).toBe("604800");
    expect(fetch).toHaveBeenCalledOnce(); expect(owner.sign).toHaveBeenCalledTimes(2);
  });
  it("uses the shared owner for tokens and the SDK's canonical V4 signing with its original scopes", async () => {
    const { url } = await getContentStorage(env).put({ key, bytes, contentType: "image/png" });
    const signed = new URL(url);
    expect(signed.searchParams.get("X-Goog-Credential")).toMatch(/^fixture@example.invalid\//);
    expect(signed.searchParams.get("X-Goog-Signature")).toBe(Buffer.from("signature").toString("hex"));
    expect(owner.sign.mock.calls[0]![0]).toMatch(/^GOOG4-RSA-SHA256\n/);
    expect(owner.metadata).toHaveBeenCalledOnce(); expect(owner.token).toHaveBeenCalledOnce();
    expect(owner.factory.mock.calls[0]![0].authOptions.scopes).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/iam", "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/devstorage.full_control",
    ]));
    expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer bounded-token");
  });
  it("does not dispatch object bytes after the owned token operation fails", async () => {
    owner.token.mockRejectedValueOnce(Error("Google credential token timeout"));
    await expect(getContentStorage(env).put({ key, bytes, contentType: "image/png" })).rejects.toMatchObject({ name: "GcsAuthenticationError" });
    expect(fetch).not.toHaveBeenCalled(); expect(owner.token).toHaveBeenCalledOnce();
  });
  it.each(["metadata", "sign"] as const)("does not acknowledge a ready URL after the owned %s operation fails", async operation => {
    owner[operation].mockRejectedValueOnce(Error(`Google credential ${operation} timeout`));
    await expect(getContentStorage(env).put({ key, bytes, contentType: "image/png" })).rejects.toThrow(/Google credential/);
    expect(owner[operation]).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("closes the owned credential client when the cached backend is reset", async () => {
    getContentStorage(env); await resetContentStorageForTests();
    expect(owner.close).toHaveBeenCalledOnce();
  });
});
